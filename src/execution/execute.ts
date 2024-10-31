import { inspect } from '../jsutils/inspect.js';
import { invariant } from '../jsutils/invariant.js';
import { isAsyncIterable } from '../jsutils/isAsyncIterable.js';
import { isIterableObject } from '../jsutils/isIterableObject.js';
import { isObjectLike } from '../jsutils/isObjectLike.js';
import { isPromise } from '../jsutils/isPromise.js';
import type { Maybe } from '../jsutils/Maybe.js';
import { memoize3 } from '../jsutils/memoize3.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { Path } from '../jsutils/Path.js';
import { addPath, pathToArray } from '../jsutils/Path.js';
import { promiseForObject } from '../jsutils/promiseForObject.js';
import type { PromiseOrValue } from '../jsutils/PromiseOrValue.js';
import { promiseReduce } from '../jsutils/promiseReduce.js';

import type { GraphQLFormattedError } from '../error/GraphQLError.js';
import { GraphQLError } from '../error/GraphQLError.js';
import { locatedError } from '../error/locatedError.js';

import type {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
} from '../language/ast.js';
import { OperationTypeNode } from '../language/ast.js';
import { Kind } from '../language/kinds.js';

import type {
  GraphQLAbstractType,
  GraphQLField,
  GraphQLFieldResolver,
  GraphQLLeafType,
  GraphQLList,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLResolveInfo,
  GraphQLTypeResolver,
} from '../type/definition.js';
import {
  isAbstractType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
} from '../type/definition.js';
import type { GraphQLSchema } from '../type/schema.js';
import { assertValidSchema } from '../type/validate.js';

import type {
  FieldDetailsList,
  FragmentDetails,
  GroupedFieldSet,
} from './collectFields.js';
import {
  collectFields,
  collectSubfields as _collectSubfields,
} from './collectFields.js';
import { getVariableSignature } from './getVariableSignature.js';
import { mapAsyncIterable } from './mapAsyncIterable.js';
import { PromiseCanceller } from './PromiseCanceller.js';
import type { VariableValues } from './values.js';
import {
  experimentalGetArgumentValues,
  getArgumentValues,
  getVariableValues,
} from './values.js';

/* eslint-disable @typescript-eslint/max-params */
// This file contains a lot of such errors but we plan to refactor it anyway
// so just disable it for entire file.

/**
 * A memoized collection of relevant subfields with regard to the return
 * type. Memoizing ensures the subfields are not repeatedly calculated, which
 * saves overhead when resolving lists of values.
 */
const collectSubfields = memoize3(
  (
    validatedExecutionArgs: ValidatedExecutionArgs,
    returnType: GraphQLObjectType,
    fieldDetailsList: FieldDetailsList,
  ) => {
    const { schema, fragments, variableValues, hideSuggestions } =
      validatedExecutionArgs;
    return _collectSubfields(
      schema,
      fragments,
      variableValues,
      returnType,
      fieldDetailsList,
      hideSuggestions,
    );
  },
);

/**
 * Terminology
 *
 * "Definitions" are the generic name for top-level statements in the document.
 * Examples of this include:
 * 1) Operations (such as a query)
 * 2) Fragments
 *
 * "Operations" are a generic name for requests in the document.
 * Examples of this include:
 * 1) query,
 * 2) mutation
 *
 * "Selections" are the definitions that can appear legally and at
 * single level of the query. These include:
 * 1) field references e.g `a`
 * 2) fragment "spreads" e.g. `...c`
 * 3) inline fragment "spreads" e.g. `...on Type { a }`
 */

/**
 * Data that must be available at all points during query execution.
 *
 * Namely, schema of the type system that is currently executing,
 * and the fragments defined in the query document
 */
export interface ValidatedExecutionArgs {
  schema: GraphQLSchema;
  // TODO: consider deprecating/removing fragmentDefinitions if/when fragment
  // arguments are officially supported and/or the full fragment details are
  // exposed within GraphQLResolveInfo.
  fragmentDefinitions: ObjMap<FragmentDefinitionNode>;
  fragments: ObjMap<FragmentDetails>;
  rootValue: unknown;
  contextValue: unknown;
  operation: OperationDefinitionNode;
  variableValues: VariableValues;
  fieldResolver: GraphQLFieldResolver<any, any>;
  typeResolver: GraphQLTypeResolver<any, any>;
  subscribeFieldResolver: GraphQLFieldResolver<any, any>;
  perEventExecutor: (
    validatedExecutionArgs: ValidatedExecutionArgs,
  ) => PromiseOrValue<ExecutionResult>;
  hideSuggestions: boolean;
  abortSignal: AbortSignal | undefined;
}

/**
 * @internal
 */
class CollectedErrors {
  private _errorPositions: Set<Path | undefined>;
  private _errors: Array<GraphQLError>;
  constructor() {
    this._errorPositions = new Set<Path | undefined>();
    this._errors = [];
  }

  get errors(): ReadonlyArray<GraphQLError> {
    return this._errors;
  }

  add(error: GraphQLError, path: Path | undefined) {
    // Do not modify errors list if the execution position for this error or
    // any of its ancestors has already been nulled via error propagation.
    // This check should be unnecessary for implementations able to implement
    // actual cancellation.
    if (this._hasNulledPosition(path)) {
      return;
    }
    this._errorPositions.add(path);
    this._errors.push(error);
  }

  private _hasNulledPosition(startPath: Path | undefined): boolean {
    let path = startPath;
    while (path !== undefined) {
      if (this._errorPositions.has(path)) {
        return true;
      }
      path = path.prev;
    }
    return this._errorPositions.has(undefined);
  }
}

export interface ExecutionContext {
  validatedExecutionArgs: ValidatedExecutionArgs;
  collectedErrors: CollectedErrors;
  promiseCanceller: PromiseCanceller | undefined;
}

/**
 * The result of GraphQL execution.
 *
 *   - `errors` is included when any errors occurred as a non-empty array.
 *   - `data` is the result of a successful execution of the query.
 *   - `extensions` is reserved for adding non-standard properties.
 */
export interface ExecutionResult<
  TData = ObjMap<unknown>,
  TExtensions = ObjMap<unknown>,
> {
  errors?: ReadonlyArray<GraphQLError>;
  data?: TData | null;
  extensions?: TExtensions;
}

export interface FormattedExecutionResult<
  TData = ObjMap<unknown>,
  TExtensions = ObjMap<unknown>,
> {
  errors?: ReadonlyArray<GraphQLFormattedError>;
  data?: TData | null;
  extensions?: TExtensions;
}

export interface ExecutionArgs {
  schema: GraphQLSchema;
  document: DocumentNode;
  rootValue?: unknown;
  contextValue?: unknown;
  variableValues?: Maybe<{ readonly [variable: string]: unknown }>;
  operationName?: Maybe<string>;
  fieldResolver?: Maybe<GraphQLFieldResolver<any, any>>;
  typeResolver?: Maybe<GraphQLTypeResolver<any, any>>;
  subscribeFieldResolver?: Maybe<GraphQLFieldResolver<any, any>>;
  perEventExecutor?: Maybe<
    (
      validatedExecutionArgs: ValidatedExecutionArgs,
    ) => PromiseOrValue<ExecutionResult>
  >;
  hideSuggestions?: Maybe<boolean>;
  abortSignal?: Maybe<AbortSignal>;
  /** Additional execution options. */
  options?: {
    /** Set the maximum number of errors allowed for coercing (defaults to 50). */
    maxCoercionErrors?: number;
  };
}

/**
 * Implements the "Executing requests" section of the GraphQL specification.
 *
 * Returns either a synchronous ExecutionResult (if all encountered resolvers
 * are synchronous), or a Promise of an ExecutionResult that will eventually be
 * resolved and never rejected.
 *
 * If the arguments to this function do not result in a legal execution context,
 * a GraphQLError will be thrown immediately explaining the invalid input.
 */
export function execute(args: ExecutionArgs): PromiseOrValue<ExecutionResult> {
  // If a valid execution context cannot be created due to incorrect arguments,
  // a "Response" with only errors is returned.
  const validatedExecutionArgs = validateExecutionArgs(args);

  // Return early errors if execution context failed.
  if (!('schema' in validatedExecutionArgs)) {
    return { errors: validatedExecutionArgs };
  }

  return executeQueryOrMutationOrSubscriptionEvent(validatedExecutionArgs);
}

/**
 * Implements the "Executing operations" section of the spec.
 *
 * Returns a Promise that will eventually resolve to the data described by
 * The "Response" section of the GraphQL specification.
 *
 * If errors are encountered while executing a GraphQL field, only that
 * field and its descendants will be omitted, and sibling fields will still
 * be executed. An execution which encounters errors will still result in a
 * resolved Promise.
 *
 * Errors from sub-fields of a NonNull type may propagate to the top level,
 * at which point we still log the error and null the parent field, which
 * in this case is the entire response.
 */
export function executeQueryOrMutationOrSubscriptionEvent(
  validatedExecutionArgs: ValidatedExecutionArgs,
): PromiseOrValue<ExecutionResult> {
  const abortSignal = validatedExecutionArgs.abortSignal;
  const exeContext: ExecutionContext = {
    validatedExecutionArgs,
    collectedErrors: new CollectedErrors(),
    promiseCanceller: abortSignal
      ? new PromiseCanceller(abortSignal)
      : undefined,
  };
  try {
    const {
      schema,
      fragments,
      rootValue,
      operation,
      variableValues,
      hideSuggestions,
    } = validatedExecutionArgs;
    const rootType = schema.getRootType(operation.operation);
    if (rootType == null) {
      throw new GraphQLError(
        `Schema is not configured to execute ${operation.operation} operation.`,
        { nodes: operation },
      );
    }

    const groupedFieldSet = collectFields(
      schema,
      fragments,
      variableValues,
      rootType,
      operation.selectionSet,
      hideSuggestions,
    );

    const result = executeRootGroupedFieldSet(
      exeContext,
      operation.operation,
      rootType,
      rootValue,
      groupedFieldSet,
    );

    if (isPromise(result)) {
      return result.then(
        (data) => buildResponse(exeContext, data),
        (error: unknown) => {
          exeContext.collectedErrors.add(error as GraphQLError, undefined);
          return buildResponse(exeContext, null);
        },
      );
    }
    return buildResponse(exeContext, result);
  } catch (error) {
    exeContext.collectedErrors.add(error, undefined);
    return buildResponse(exeContext, null);
  }
}

/**
 * Also implements the "Executing requests" section of the GraphQL specification.
 * However, it guarantees to complete synchronously (or throw an error) assuming
 * that all field resolvers are also synchronous.
 */
export function executeSync(args: ExecutionArgs): ExecutionResult {
  const result = execute(args);

  // Assert that the execution was synchronous.
  if (isPromise(result)) {
    throw new Error('GraphQL execution failed to complete synchronously.');
  }

  return result;
}

/**
 * Given a completed execution context and data, build the `{ errors, data }`
 * response defined by the "Response" section of the GraphQL specification.
 */
function buildResponse(
  exeContext: ExecutionContext,
  data: ObjMap<unknown> | null,
): ExecutionResult {
  exeContext.promiseCanceller?.disconnect();
  const errors = exeContext.collectedErrors.errors;
  return errors.length === 0 ? { data } : { errors, data };
}

/**
 * Constructs a ExecutionContext object from the arguments passed to
 * execute, which we will pass throughout the other execution methods.
 *
 * Throws a GraphQLError if a valid execution context cannot be created.
 *
 * TODO: consider no longer exporting this function
 * @internal
 */
export function validateExecutionArgs(
  args: ExecutionArgs,
): ReadonlyArray<GraphQLError> | ValidatedExecutionArgs {
  const {
    schema,
    document,
    rootValue,
    contextValue,
    variableValues: rawVariableValues,
    operationName,
    fieldResolver,
    typeResolver,
    subscribeFieldResolver,
    perEventExecutor,
    abortSignal,
    options,
  } = args;

  if (abortSignal?.aborted) {
    return [locatedError(abortSignal.reason, undefined)];
  }

  // If the schema used for execution is invalid, throw an error.
  assertValidSchema(schema);

  let operation: OperationDefinitionNode | undefined;
  const fragmentDefinitions: ObjMap<FragmentDefinitionNode> =
    Object.create(null);
  const fragments: ObjMap<FragmentDetails> = Object.create(null);
  for (const definition of document.definitions) {
    switch (definition.kind) {
      case Kind.OPERATION_DEFINITION:
        if (operationName == null) {
          if (operation !== undefined) {
            return [
              new GraphQLError(
                'Must provide operation name if query contains multiple operations.',
              ),
            ];
          }
          operation = definition;
        } else if (definition.name?.value === operationName) {
          operation = definition;
        }
        break;
      case Kind.FRAGMENT_DEFINITION: {
        fragmentDefinitions[definition.name.value] = definition;
        let variableSignatures;
        if (definition.variableDefinitions) {
          variableSignatures = Object.create(null);
          for (const varDef of definition.variableDefinitions) {
            const signature = getVariableSignature(schema, varDef);
            variableSignatures[signature.name] = signature;
          }
        }
        fragments[definition.name.value] = { definition, variableSignatures };
        break;
      }
      default:
      // ignore non-executable definitions
    }
  }

  if (!operation) {
    if (operationName != null) {
      return [new GraphQLError(`Unknown operation named "${operationName}".`)];
    }
    return [new GraphQLError('Must provide an operation.')];
  }

  const variableDefinitions = operation.variableDefinitions ?? [];
  const hideSuggestions = args.hideSuggestions ?? false;

  const variableValuesOrErrors = getVariableValues(
    schema,
    variableDefinitions,
    rawVariableValues ?? {},
    {
      maxErrors: options?.maxCoercionErrors ?? 50,
      hideSuggestions,
    },
  );

  if (variableValuesOrErrors.errors) {
    return variableValuesOrErrors.errors;
  }

  return {
    schema,
    fragmentDefinitions,
    fragments,
    rootValue,
    contextValue,
    operation,
    variableValues: variableValuesOrErrors.variableValues,
    fieldResolver: fieldResolver ?? defaultFieldResolver,
    typeResolver: typeResolver ?? defaultTypeResolver,
    subscribeFieldResolver: subscribeFieldResolver ?? defaultFieldResolver,
    perEventExecutor: perEventExecutor ?? executeSubscriptionEvent,
    hideSuggestions,
    abortSignal: args.abortSignal ?? undefined,
  };
}

function executeRootGroupedFieldSet(
  exeContext: ExecutionContext,
  operation: OperationTypeNode,
  rootType: GraphQLObjectType,
  rootValue: unknown,
  groupedFieldSet: GroupedFieldSet,
): PromiseOrValue<ObjMap<unknown>> {
  switch (operation) {
    case OperationTypeNode.QUERY:
      return executeFields(
        exeContext,
        rootType,
        rootValue,
        undefined,
        groupedFieldSet,
      );
    case OperationTypeNode.MUTATION:
      return executeFieldsSerially(
        exeContext,
        rootType,
        rootValue,
        undefined,
        groupedFieldSet,
      );
    case OperationTypeNode.SUBSCRIPTION:
      // TODO: deprecate `subscribe` and move all logic here
      // Temporary solution until we finish merging execute and subscribe together
      return executeFields(
        exeContext,
        rootType,
        rootValue,
        undefined,
        groupedFieldSet,
      );
  }
}

/**
 * Implements the "Executing selection sets" section of the spec
 * for fields that must be executed serially.
 */
function executeFieldsSerially(
  exeContext: ExecutionContext,
  parentType: GraphQLObjectType,
  sourceValue: unknown,
  path: Path | undefined,
  groupedFieldSet: GroupedFieldSet,
): PromiseOrValue<ObjMap<unknown>> {
  return promiseReduce(
    groupedFieldSet,
    (results, [responseName, fieldDetailsList]) => {
      const fieldPath = addPath(path, responseName, parentType.name);
      const abortSignal = exeContext.validatedExecutionArgs.abortSignal;
      if (abortSignal?.aborted) {
        handleFieldError(
          abortSignal.reason,
          exeContext,
          parentType,
          fieldDetailsList,
          fieldPath,
        );
        results[responseName] = null;
        return results;
      }

      const result = executeField(
        exeContext,
        parentType,
        sourceValue,
        fieldDetailsList,
        fieldPath,
      );
      if (result === undefined) {
        return results;
      }
      if (isPromise(result)) {
        return result.then((resolvedResult) => {
          results[responseName] = resolvedResult;
          return results;
        });
      }
      results[responseName] = result;
      return results;
    },
    Object.create(null),
  );
}

/**
 * Implements the "Executing selection sets" section of the spec
 * for fields that may be executed in parallel.
 */
function executeFields(
  exeContext: ExecutionContext,
  parentType: GraphQLObjectType,
  sourceValue: unknown,
  path: Path | undefined,
  groupedFieldSet: GroupedFieldSet,
): PromiseOrValue<ObjMap<unknown>> {
  const results = Object.create(null);
  let containsPromise = false;

  try {
    for (const [responseName, fieldDetailsList] of groupedFieldSet) {
      const fieldPath = addPath(path, responseName, parentType.name);
      const result = executeField(
        exeContext,
        parentType,
        sourceValue,
        fieldDetailsList,
        fieldPath,
      );

      if (result !== undefined) {
        results[responseName] = result;
        if (isPromise(result)) {
          containsPromise = true;
        }
      }
    }
  } catch (error) {
    if (containsPromise) {
      // Ensure that any promises returned by other fields are handled, as they may also reject.
      return promiseForObject(results).finally(() => {
        throw error;
      });
    }
    throw error;
  }

  // If there are no promises, we can just return the object
  if (!containsPromise) {
    return results;
  }

  // Otherwise, results is a map from field name to the result of resolving that
  // field, which is possibly a promise. Return a promise that will return this
  // same map, but with any promises replaced with the values they resolved to.
  return promiseForObject(results);
}

/**
 * Implements the "Executing fields" section of the spec
 * In particular, this function figures out the value that the field returns by
 * calling its resolve function, then calls completeValue to complete promises,
 * coercing scalars, or execute the sub-selection-set for objects.
 */
function executeField(
  exeContext: ExecutionContext,
  parentType: GraphQLObjectType,
  source: unknown,
  fieldDetailsList: FieldDetailsList,
  path: Path,
): PromiseOrValue<unknown> {
  const { validatedExecutionArgs, promiseCanceller } = exeContext;
  const { schema, contextValue, variableValues, hideSuggestions, abortSignal } =
    validatedExecutionArgs;
  const firstFieldDetails = fieldDetailsList[0];
  const firstFieldNode = firstFieldDetails.node;
  const fieldName = firstFieldNode.name.value;

  const fieldDef = schema.getField(parentType, fieldName);
  if (!fieldDef) {
    return;
  }

  const returnType = fieldDef.type;
  const resolveFn = fieldDef.resolve ?? validatedExecutionArgs.fieldResolver;

  const info = buildResolveInfo(
    validatedExecutionArgs,
    fieldDef,
    toNodes(fieldDetailsList),
    parentType,
    path,
  );

  // Get the resolve function, regardless of if its result is normal or abrupt (error).
  try {
    // Build a JS object of arguments from the field.arguments AST, using the
    // variables scope to fulfill any variable references.
    // TODO: find a way to memoize, in case this field is within a List type.
    const args = experimentalGetArgumentValues(
      firstFieldNode,
      fieldDef.args,
      variableValues,
      firstFieldDetails.fragmentVariableValues,
      hideSuggestions,
    );

    // The resolve function's optional third argument is a context value that
    // is provided to every resolve function within an execution. It is commonly
    // used to represent an authenticated user, or request-specific caches.
    const result = resolveFn(source, args, contextValue, info, abortSignal);

    if (isPromise(result)) {
      return completePromisedValue(
        exeContext,
        returnType,
        fieldDetailsList,
        info,
        path,
        promiseCanceller?.withCancellation(result) ?? result,
      );
    }

    const completed = completeValue(
      exeContext,
      returnType,
      fieldDetailsList,
      info,
      path,
      result,
    );

    if (isPromise(completed)) {
      // Note: we don't rely on a `catch` method, but we do expect "thenable"
      // to take a second callback for the error case.
      return completed.then(undefined, (rawError: unknown) => {
        handleFieldError(
          rawError,
          exeContext,
          returnType,
          fieldDetailsList,
          path,
        );
        return null;
      });
    }
    return completed;
  } catch (rawError) {
    handleFieldError(rawError, exeContext, returnType, fieldDetailsList, path);
    return null;
  }
}

function toNodes(fieldDetailsList: FieldDetailsList): ReadonlyArray<FieldNode> {
  return fieldDetailsList.map((fieldDetails) => fieldDetails.node);
}

/**
 * TODO: consider no longer exporting this function
 * @internal
 */
export function buildResolveInfo(
  validatedExecutionArgs: ValidatedExecutionArgs,
  fieldDef: GraphQLField<unknown, unknown>,
  fieldNodes: ReadonlyArray<FieldNode>,
  parentType: GraphQLObjectType,
  path: Path,
): GraphQLResolveInfo {
  const { schema, fragmentDefinitions, rootValue, operation, variableValues } =
    validatedExecutionArgs;
  // The resolve function's optional fourth argument is a collection of
  // information about the current execution state.
  return {
    fieldName: fieldDef.name,
    fieldNodes,
    returnType: fieldDef.type,
    parentType,
    path,
    schema,
    fragments: fragmentDefinitions,
    rootValue,
    operation,
    variableValues,
  };
}

function handleFieldError(
  rawError: unknown,
  exeContext: ExecutionContext,
  returnType: GraphQLOutputType,
  fieldDetailsList: FieldDetailsList,
  path: Path,
): void {
  const error = locatedError(
    rawError,
    toNodes(fieldDetailsList),
    pathToArray(path),
  );

  // If the field type is non-nullable, then it is resolved without any
  // protection from errors, however it still properly locates the error.
  if (isNonNullType(returnType)) {
    throw error;
  }

  // Otherwise, error protection is applied, logging the error and resolving
  // a null value for this field if one is encountered.
  exeContext.collectedErrors.add(error, path);
}

/**
 * Implements the instructions for completeValue as defined in the
 * "Value Completion" section of the spec.
 *
 * If the field type is Non-Null, then this recursively completes the value
 * for the inner type. It throws a field error if that completion returns null,
 * as per the "Nullability" section of the spec.
 *
 * If the field type is a List, then this recursively completes the value
 * for the inner type on each item in the list.
 *
 * If the field type is a Scalar or Enum, ensures the completed value is a legal
 * value of the type by calling the `coerceOutputValue` method of GraphQL type
 * definition.
 *
 * If the field is an abstract type, determine the runtime type of the value
 * and then complete based on that type
 *
 * Otherwise, the field type expects a sub-selection set, and will complete the
 * value by executing all sub-selections.
 */
function completeValue(
  exeContext: ExecutionContext,
  returnType: GraphQLOutputType,
  fieldDetailsList: FieldDetailsList,
  info: GraphQLResolveInfo,
  path: Path,
  result: unknown,
): PromiseOrValue<unknown> {
  // If result is an Error, throw a located error.
  if (result instanceof Error) {
    throw result;
  }

  // If field type is NonNull, complete for inner type, and throw field error
  // if result is null.
  if (isNonNullType(returnType)) {
    const completed = completeValue(
      exeContext,
      returnType.ofType,
      fieldDetailsList,
      info,
      path,
      result,
    );
    if (completed === null) {
      throw new Error(
        `Cannot return null for non-nullable field ${info.parentType}.${info.fieldName}.`,
      );
    }
    return completed;
  }

  // If result value is null or undefined then return null.
  if (result == null) {
    return null;
  }

  // If field type is List, complete each item in the list with the inner type
  if (isListType(returnType)) {
    return completeListValue(
      exeContext,
      returnType,
      fieldDetailsList,
      info,
      path,
      result,
    );
  }

  // If field type is a leaf type, Scalar or Enum, coerce to a valid value,
  // returning null if coercion is not possible.
  if (isLeafType(returnType)) {
    return completeLeafValue(returnType, result);
  }

  // If field type is an abstract type, Interface or Union, determine the
  // runtime Object type and complete for that type.
  if (isAbstractType(returnType)) {
    return completeAbstractValue(
      exeContext,
      returnType,
      fieldDetailsList,
      info,
      path,
      result,
    );
  }

  // If field type is Object, execute and complete all sub-selections.
  if (isObjectType(returnType)) {
    return completeObjectValue(
      exeContext,
      returnType,
      fieldDetailsList,
      info,
      path,
      result,
    );
  } /* c8 ignore next 6 */
  // Not reachable, all possible output types have been considered.
  invariant(
    false,
    'Cannot complete value of unexpected output type: ' + inspect(returnType),
  );
}

async function completePromisedValue(
  exeContext: ExecutionContext,
  returnType: GraphQLOutputType,
  fieldDetailsList: FieldDetailsList,
  info: GraphQLResolveInfo,
  path: Path,
  result: Promise<unknown>,
): Promise<unknown> {
  try {
    const resolved = await result;
    let completed = completeValue(
      exeContext,
      returnType,
      fieldDetailsList,
      info,
      path,
      resolved,
    );
    if (isPromise(completed)) {
      completed = await completed;
    }
    return completed;
  } catch (rawError) {
    handleFieldError(rawError, exeContext, returnType, fieldDetailsList, path);
    return null;
  }
}

/**
 * Complete a async iterator value by completing the result and calling
 * recursively until all the results are completed.
 */
async function completeAsyncIteratorValue(
  exeContext: ExecutionContext,
  itemType: GraphQLOutputType,
  fieldDetailsList: FieldDetailsList,
  info: GraphQLResolveInfo,
  path: Path,
  asyncIterator: AsyncIterator<unknown>,
): Promise<ReadonlyArray<unknown>> {
  let containsPromise = false;
  const completedResults: Array<unknown> = [];
  let index = 0;
  const earlyReturn = asyncIterator.return?.bind(asyncIterator);
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const itemPath = addPath(path, index, undefined);
      let iteration;
      try {
        // eslint-disable-next-line no-await-in-loop
        iteration = await asyncIterator.next();
      } catch (rawError) {
        throw locatedError(
          rawError,
          toNodes(fieldDetailsList),
          pathToArray(path),
        );
      }

      // TODO: add test case for stream returning done before initialCount
      /* c8 ignore next 3 */
      if (iteration.done) {
        break;
      }

      const item = iteration.value;
      // TODO: add tests for stream backed by asyncIterator that returns a promise
      /* c8 ignore start */
      if (isPromise(item)) {
        completedResults.push(
          completePromisedListItemValue(
            item,
            exeContext,
            itemType,
            fieldDetailsList,
            info,
            itemPath,
          ),
        );
        containsPromise = true;
      } else if (
        /* c8 ignore stop */
        completeListItemValue(
          item,
          completedResults,
          exeContext,
          itemType,
          fieldDetailsList,
          info,
          itemPath,
        )
        // TODO: add tests for stream backed by asyncIterator that completes to a promise
        /* c8 ignore start */
      ) {
        containsPromise = true;
      }
      /* c8 ignore stop */
      index++;
    }
  } catch (error) {
    if (earlyReturn !== undefined) {
      earlyReturn().catch(() => {
        /* c8 ignore next 1 */
        // ignore error
      });
    }
    throw error;
  }
  return containsPromise ? Promise.all(completedResults) : completedResults;
}

/**
 * Complete a list value by completing each item in the list with the
 * inner type
 */
function completeListValue(
  exeContext: ExecutionContext,
  returnType: GraphQLList<GraphQLOutputType>,
  fieldDetailsList: FieldDetailsList,
  info: GraphQLResolveInfo,
  path: Path,
  result: unknown,
): PromiseOrValue<ReadonlyArray<unknown>> {
  const itemType = returnType.ofType;

  if (isAsyncIterable(result)) {
    const asyncIterator = result[Symbol.asyncIterator]();

    return completeAsyncIteratorValue(
      exeContext,
      itemType,
      fieldDetailsList,
      info,
      path,
      asyncIterator,
    );
  }

  if (!isIterableObject(result)) {
    throw new GraphQLError(
      `Expected Iterable, but did not find one for field "${info.parentType}.${info.fieldName}".`,
    );
  }

  return completeIterableValue(
    exeContext,
    itemType,
    fieldDetailsList,
    info,
    path,
    result,
  );
}

function completeIterableValue(
  exeContext: ExecutionContext,
  itemType: GraphQLOutputType,
  fieldDetailsList: FieldDetailsList,
  info: GraphQLResolveInfo,
  path: Path,
  items: Iterable<unknown>,
): PromiseOrValue<ReadonlyArray<unknown>> {
  // This is specified as a simple map, however we're optimizing the path
  // where the list contains no Promises by avoiding creating another Promise.
  let containsPromise = false;
  const completedResults: Array<unknown> = [];
  let index = 0;
  const iterator = items[Symbol.iterator]();
  let iteration = iterator.next();
  while (!iteration.done) {
    const item = iteration.value;

    // No need to modify the info object containing the path,
    // since from here on it is not ever accessed by resolver functions.
    const itemPath = addPath(path, index, undefined);

    if (isPromise(item)) {
      completedResults.push(
        completePromisedListItemValue(
          item,
          exeContext,
          itemType,
          fieldDetailsList,
          info,
          itemPath,
        ),
      );
      containsPromise = true;
    } else if (
      completeListItemValue(
        item,
        completedResults,
        exeContext,
        itemType,
        fieldDetailsList,
        info,
        itemPath,
      )
    ) {
      containsPromise = true;
    }

    index++;
    iteration = iterator.next();
  }

  return containsPromise ? Promise.all(completedResults) : completedResults;
}

/**
 * Complete a list item value by adding it to the completed results.
 *
 * Returns true if the value is a Promise.
 */
function completeListItemValue(
  item: unknown,
  completedResults: Array<unknown>,
  exeContext: ExecutionContext,
  itemType: GraphQLOutputType,
  fieldDetailsList: FieldDetailsList,
  info: GraphQLResolveInfo,
  itemPath: Path,
): boolean {
  try {
    const completedItem = completeValue(
      exeContext,
      itemType,
      fieldDetailsList,
      info,
      itemPath,
      item,
    );

    if (isPromise(completedItem)) {
      // Note: we don't rely on a `catch` method, but we do expect "thenable"
      // to take a second callback for the error case.
      completedResults.push(
        completedItem.then(undefined, (rawError: unknown) => {
          handleFieldError(
            rawError,
            exeContext,
            itemType,
            fieldDetailsList,
            itemPath,
          );
          return null;
        }),
      );

      return true;
    }

    completedResults.push(completedItem);
  } catch (rawError) {
    handleFieldError(
      rawError,
      exeContext,
      itemType,
      fieldDetailsList,
      itemPath,
    );
    completedResults.push(null);
  }

  return false;
}

async function completePromisedListItemValue(
  item: Promise<unknown>,
  exeContext: ExecutionContext,
  itemType: GraphQLOutputType,
  fieldDetailsList: FieldDetailsList,
  info: GraphQLResolveInfo,
  itemPath: Path,
): Promise<unknown> {
  try {
    const resolved = await (exeContext.promiseCanceller?.withCancellation(
      item,
    ) ?? item);
    let completed = completeValue(
      exeContext,
      itemType,
      fieldDetailsList,
      info,
      itemPath,
      resolved,
    );
    if (isPromise(completed)) {
      completed = await completed;
    }
    return completed;
  } catch (rawError) {
    handleFieldError(
      rawError,
      exeContext,
      itemType,
      fieldDetailsList,
      itemPath,
    );
    return null;
  }
}

/**
 * Complete a Scalar or Enum by serializing to a valid value, returning
 * null if serialization is not possible.
 */
function completeLeafValue(
  returnType: GraphQLLeafType,
  result: unknown,
): unknown {
  const coerced = returnType.coerceOutputValue(result);
  if (coerced == null) {
    throw new Error(
      `Expected \`${inspect(returnType)}.coerceOutputValue(${inspect(
        result,
      )})\` to return non-nullable value, returned: ${inspect(coerced)}`,
    );
  }
  return coerced;
}

/**
 * Complete a value of an abstract type by determining the runtime object type
 * of that value, then complete the value for that type.
 */
function completeAbstractValue(
  exeContext: ExecutionContext,
  returnType: GraphQLAbstractType,
  fieldDetailsList: FieldDetailsList,
  info: GraphQLResolveInfo,
  path: Path,
  result: unknown,
): PromiseOrValue<ObjMap<unknown>> {
  const validatedExecutionArgs = exeContext.validatedExecutionArgs;
  const { schema, contextValue } = validatedExecutionArgs;
  const resolveTypeFn =
    returnType.resolveType ?? validatedExecutionArgs.typeResolver;
  const runtimeType = resolveTypeFn(result, contextValue, info, returnType);

  if (isPromise(runtimeType)) {
    return runtimeType.then((resolvedRuntimeType) =>
      completeObjectValue(
        exeContext,
        ensureValidRuntimeType(
          resolvedRuntimeType,
          schema,
          returnType,
          fieldDetailsList,
          info,
          result,
        ),
        fieldDetailsList,
        info,
        path,
        result,
      ),
    );
  }

  return completeObjectValue(
    exeContext,
    ensureValidRuntimeType(
      runtimeType,
      schema,
      returnType,
      fieldDetailsList,
      info,
      result,
    ),
    fieldDetailsList,
    info,
    path,
    result,
  );
}

function ensureValidRuntimeType(
  runtimeTypeName: unknown,
  schema: GraphQLSchema,
  returnType: GraphQLAbstractType,
  fieldDetailsList: FieldDetailsList,
  info: GraphQLResolveInfo,
  result: unknown,
): GraphQLObjectType {
  if (runtimeTypeName == null) {
    throw new GraphQLError(
      `Abstract type "${returnType}" must resolve to an Object type at runtime for field "${info.parentType}.${info.fieldName}". Either the "${returnType}" type should provide a "resolveType" function or each possible type should provide an "isTypeOf" function.`,
      { nodes: toNodes(fieldDetailsList) },
    );
  }

  if (typeof runtimeTypeName !== 'string') {
    throw new GraphQLError(
      `Abstract type "${returnType}" must resolve to an Object type at runtime for field "${info.parentType}.${info.fieldName}" with ` +
        `value ${inspect(result)}, received "${inspect(
          runtimeTypeName,
        )}", which is not a valid Object type name.`,
    );
  }

  const runtimeType = schema.getType(runtimeTypeName);
  if (runtimeType == null) {
    throw new GraphQLError(
      `Abstract type "${returnType}" was resolved to a type "${runtimeTypeName}" that does not exist inside the schema.`,
      { nodes: toNodes(fieldDetailsList) },
    );
  }

  if (!isObjectType(runtimeType)) {
    throw new GraphQLError(
      `Abstract type "${returnType}" was resolved to a non-object type "${runtimeTypeName}".`,
      { nodes: toNodes(fieldDetailsList) },
    );
  }

  if (!schema.isSubType(returnType, runtimeType)) {
    throw new GraphQLError(
      `Runtime Object type "${runtimeType}" is not a possible type for "${returnType}".`,
      { nodes: toNodes(fieldDetailsList) },
    );
  }

  return runtimeType;
}

/**
 * Complete an Object value by executing all sub-selections.
 */
function completeObjectValue(
  exeContext: ExecutionContext,
  returnType: GraphQLObjectType,
  fieldDetailsList: FieldDetailsList,
  info: GraphQLResolveInfo,
  path: Path,
  result: unknown,
): PromiseOrValue<ObjMap<unknown>> {
  // If there is an isTypeOf predicate function, call it with the
  // current result. If isTypeOf returns false, then raise an error rather
  // than continuing execution.
  if (returnType.isTypeOf) {
    const isTypeOf = returnType.isTypeOf(
      result,
      exeContext.validatedExecutionArgs.contextValue,
      info,
    );

    if (isPromise(isTypeOf)) {
      return isTypeOf.then((resolvedIsTypeOf) => {
        if (!resolvedIsTypeOf) {
          throw invalidReturnTypeError(returnType, result, fieldDetailsList);
        }
        return collectAndExecuteSubfields(
          exeContext,
          returnType,
          fieldDetailsList,
          path,
          result,
        );
      });
    }

    if (!isTypeOf) {
      throw invalidReturnTypeError(returnType, result, fieldDetailsList);
    }
  }

  return collectAndExecuteSubfields(
    exeContext,
    returnType,
    fieldDetailsList,
    path,
    result,
  );
}

function invalidReturnTypeError(
  returnType: GraphQLObjectType,
  result: unknown,
  fieldDetailsList: FieldDetailsList,
): GraphQLError {
  return new GraphQLError(
    `Expected value of type "${returnType}" but got: ${inspect(result)}.`,
    { nodes: toNodes(fieldDetailsList) },
  );
}

function collectAndExecuteSubfields(
  exeContext: ExecutionContext,
  returnType: GraphQLObjectType,
  fieldDetailsList: FieldDetailsList,
  path: Path,
  result: unknown,
): PromiseOrValue<ObjMap<unknown>> {
  // Collect sub-fields to execute to complete this value.
  const subGroupedFieldSet = collectSubfields(
    exeContext.validatedExecutionArgs,
    returnType,
    fieldDetailsList,
  );

  return executeFields(
    exeContext,
    returnType,
    result,
    path,
    subGroupedFieldSet,
  );
}

/**
 * If a resolveType function is not given, then a default resolve behavior is
 * used which attempts two strategies:
 *
 * First, See if the provided value has a `__typename` field defined, if so, use
 * that value as name of the resolved type.
 *
 * Otherwise, test each possible type for the abstract type by calling
 * isTypeOf for the object being coerced, returning the first type that matches.
 */
export const defaultTypeResolver: GraphQLTypeResolver<unknown, unknown> =
  function (value, contextValue, info, abstractType) {
    // First, look for `__typename`.
    if (isObjectLike(value) && typeof value.__typename === 'string') {
      return value.__typename;
    }

    // Otherwise, test each possible type.
    const possibleTypes = info.schema.getPossibleTypes(abstractType);
    const promisedIsTypeOfResults = [];

    for (let i = 0; i < possibleTypes.length; i++) {
      const type = possibleTypes[i];

      if (type.isTypeOf) {
        const isTypeOfResult = type.isTypeOf(value, contextValue, info);

        if (isPromise(isTypeOfResult)) {
          promisedIsTypeOfResults[i] = isTypeOfResult;
        } else if (isTypeOfResult) {
          if (promisedIsTypeOfResults.length) {
            // Explicitly ignore any promise rejections
            Promise.allSettled(promisedIsTypeOfResults)
              /* c8 ignore next 3 */
              .catch(() => {
                // Do nothing
              });
          }
          return type.name;
        }
      }
    }

    if (promisedIsTypeOfResults.length) {
      return Promise.all(promisedIsTypeOfResults).then((isTypeOfResults) => {
        for (let i = 0; i < isTypeOfResults.length; i++) {
          if (isTypeOfResults[i]) {
            return possibleTypes[i].name;
          }
        }
      });
    }
  };

/**
 * If a resolve function is not given, then a default resolve behavior is used
 * which takes the property of the source object of the same name as the field
 * and returns it as the result, or if it's a function, returns the result
 * of calling that function while passing along args and context value.
 */
export const defaultFieldResolver: GraphQLFieldResolver<unknown, unknown> =
  function (source: any, args, contextValue, info, abortSignal) {
    // ensure source is a value for which property access is acceptable.
    if (isObjectLike(source) || typeof source === 'function') {
      const property = source[info.fieldName];
      if (typeof property === 'function') {
        return source[info.fieldName](args, contextValue, info, abortSignal);
      }
      return property;
    }
  };

/**
 * Implements the "Subscribe" algorithm described in the GraphQL specification.
 *
 * Returns a Promise which resolves to either an AsyncIterator (if successful)
 * or an ExecutionResult (error). The promise will be rejected if the schema or
 * other arguments to this function are invalid, or if the resolved event stream
 * is not an async iterable.
 *
 * If the client-provided arguments to this function do not result in a
 * compliant subscription, a GraphQL Response (ExecutionResult) with
 * descriptive errors and no data will be returned.
 *
 * If the source stream could not be created due to faulty subscription
 * resolver logic or underlying systems, the promise will resolve to a single
 * ExecutionResult containing `errors` and no `data`.
 *
 * If the operation succeeded, the promise resolves to an AsyncIterator, which
 * yields a stream of ExecutionResults representing the response stream.
 *
 * Accepts either an object with named arguments, or individual arguments.
 */
export function subscribe(
  args: ExecutionArgs,
): PromiseOrValue<
  AsyncGenerator<ExecutionResult, void, void> | ExecutionResult
> {
  // If a valid execution context cannot be created due to incorrect arguments,
  // a "Response" with only errors is returned.
  const validatedExecutionArgs = validateExecutionArgs(args);

  // Return early errors if execution context failed.
  if (!('schema' in validatedExecutionArgs)) {
    return { errors: validatedExecutionArgs };
  }

  const resultOrStream = createSourceEventStreamImpl(validatedExecutionArgs);

  if (isPromise(resultOrStream)) {
    return resultOrStream.then((resolvedResultOrStream) =>
      mapSourceToResponse(validatedExecutionArgs, resolvedResultOrStream),
    );
  }

  return mapSourceToResponse(validatedExecutionArgs, resultOrStream);
}

function mapSourceToResponse(
  validatedExecutionArgs: ValidatedExecutionArgs,
  resultOrStream: ExecutionResult | AsyncIterable<unknown>,
): AsyncGenerator<ExecutionResult, void, void> | ExecutionResult {
  if (!isAsyncIterable(resultOrStream)) {
    return resultOrStream;
  }

  // For each payload yielded from a subscription, map it over the normal
  // GraphQL `execute` function, with `payload` as the rootValue.
  // This implements the "MapSourceToResponseEvent" algorithm described in
  // the GraphQL specification..
  return mapAsyncIterable(resultOrStream, (payload: unknown) => {
    const perEventExecutionArgs: ValidatedExecutionArgs = {
      ...validatedExecutionArgs,
      rootValue: payload,
    };
    return validatedExecutionArgs.perEventExecutor(perEventExecutionArgs);
  });
}

export function executeSubscriptionEvent(
  validatedExecutionArgs: ValidatedExecutionArgs,
): PromiseOrValue<ExecutionResult> {
  return executeQueryOrMutationOrSubscriptionEvent(validatedExecutionArgs);
}

/**
 * Implements the "CreateSourceEventStream" algorithm described in the
 * GraphQL specification, resolving the subscription source event stream.
 *
 * Returns a Promise which resolves to either an AsyncIterable (if successful)
 * or an ExecutionResult (error). The promise will be rejected if the schema or
 * other arguments to this function are invalid, or if the resolved event stream
 * is not an async iterable.
 *
 * If the client-provided arguments to this function do not result in a
 * compliant subscription, a GraphQL Response (ExecutionResult) with
 * descriptive errors and no data will be returned.
 *
 * If the the source stream could not be created due to faulty subscription
 * resolver logic or underlying systems, the promise will resolve to a single
 * ExecutionResult containing `errors` and no `data`.
 *
 * If the operation succeeded, the promise resolves to the AsyncIterable for the
 * event stream returned by the resolver.
 *
 * A Source Event Stream represents a sequence of events, each of which triggers
 * a GraphQL execution for that event.
 *
 * This may be useful when hosting the stateful subscription service in a
 * different process or machine than the stateless GraphQL execution engine,
 * or otherwise separating these two steps. For more on this, see the
 * "Supporting Subscriptions at Scale" information in the GraphQL specification.
 */
export function createSourceEventStream(
  args: ExecutionArgs,
): PromiseOrValue<AsyncIterable<unknown> | ExecutionResult> {
  // If a valid execution context cannot be created due to incorrect arguments,
  // a "Response" with only errors is returned.
  const validatedExecutionArgs = validateExecutionArgs(args);

  // Return early errors if execution context failed.
  if (!('schema' in validatedExecutionArgs)) {
    return { errors: validatedExecutionArgs };
  }

  return createSourceEventStreamImpl(validatedExecutionArgs);
}

function createSourceEventStreamImpl(
  validatedExecutionArgs: ValidatedExecutionArgs,
): PromiseOrValue<AsyncIterable<unknown> | ExecutionResult> {
  try {
    const eventStream = executeSubscription(validatedExecutionArgs);
    if (isPromise(eventStream)) {
      return eventStream.then(undefined, (error: unknown) => ({
        errors: [error as GraphQLError],
      }));
    }

    return eventStream;
  } catch (error) {
    return { errors: [error] };
  }
}

function executeSubscription(
  validatedExecutionArgs: ValidatedExecutionArgs,
): PromiseOrValue<AsyncIterable<unknown>> {
  const {
    schema,
    fragments,
    rootValue,
    contextValue,
    operation,
    variableValues,
    hideSuggestions,
    abortSignal,
  } = validatedExecutionArgs;

  const rootType = schema.getSubscriptionType();
  if (rootType == null) {
    throw new GraphQLError(
      'Schema is not configured to execute subscription operation.',
      { nodes: operation },
    );
  }

  const groupedFieldSet = collectFields(
    schema,
    fragments,
    variableValues,
    rootType,
    operation.selectionSet,
    hideSuggestions,
  );

  const firstRootField = groupedFieldSet.entries().next().value as [
    string,
    FieldDetailsList,
  ];
  const [responseName, fieldDetailsList] = firstRootField;
  const fieldName = fieldDetailsList[0].node.name.value;
  const fieldDef = schema.getField(rootType, fieldName);

  const fieldNodes = fieldDetailsList.map((fieldDetails) => fieldDetails.node);
  if (!fieldDef) {
    throw new GraphQLError(
      `The subscription field "${fieldName}" is not defined.`,
      { nodes: fieldNodes },
    );
  }

  const path = addPath(undefined, responseName, rootType.name);
  const info = buildResolveInfo(
    validatedExecutionArgs,
    fieldDef,
    toNodes(fieldDetailsList),
    rootType,
    path,
  );

  try {
    // Implements the "ResolveFieldEventStream" algorithm from GraphQL specification.
    // It differs from "ResolveFieldValue" due to providing a different `resolveFn`.

    // Build a JS object of arguments from the field.arguments AST, using the
    // variables scope to fulfill any variable references.
    const args = getArgumentValues(
      fieldDef,
      fieldNodes[0],
      variableValues,
      hideSuggestions,
    );

    // Call the `subscribe()` resolver or the default resolver to produce an
    // AsyncIterable yielding raw payloads.
    const resolveFn =
      fieldDef.subscribe ?? validatedExecutionArgs.subscribeFieldResolver;

    // The resolve function's optional third argument is a context value that
    // is provided to every resolve function within an execution. It is commonly
    // used to represent an authenticated user, or request-specific caches.
    const result = resolveFn(rootValue, args, contextValue, info, abortSignal);

    if (isPromise(result)) {
      const promiseCanceller = abortSignal
        ? new PromiseCanceller(abortSignal)
        : undefined;
      const promise = promiseCanceller?.withCancellation(result) ?? result;
      return promise.then(assertEventStream).then(
        (resolved) => {
          // TODO: add test case
          /* c8 ignore next */
          promiseCanceller?.disconnect();
          return resolved;
        },
        (error: unknown) => {
          promiseCanceller?.disconnect();
          throw locatedError(error, fieldNodes, pathToArray(path));
        },
      );
    }

    return assertEventStream(result);
  } catch (error) {
    throw locatedError(error, fieldNodes, pathToArray(path));
  }
}

function assertEventStream(result: unknown): AsyncIterable<unknown> {
  if (result instanceof Error) {
    throw result;
  }

  // Assert field returned an event stream, otherwise yield an error.
  if (!isAsyncIterable(result)) {
    throw new GraphQLError(
      'Subscription field must return Async Iterable. ' +
        `Received: ${inspect(result)}.`,
    );
  }

  return result;
}
