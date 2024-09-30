import { didYouMean } from '../../jsutils/didYouMean.js';
import { inspect } from '../../jsutils/inspect.js';
import { suggestionList } from '../../jsutils/suggestionList.js';

import { GraphQLError } from '../../error/GraphQLError.js';

import type {
  ObjectFieldNode,
  ObjectValueNode,
  ValueNode,
  VariableDefinitionNode,
} from '../../language/ast.js';
import { Kind } from '../../language/kinds.js';
import { print } from '../../language/printer.js';
import type { ASTVisitor } from '../../language/visitor.js';

import type { GraphQLInputObjectType } from '../../type/definition.js';
import {
  getNamedType,
  getNullableType,
  isInputObjectType,
  isLeafType,
  isListType,
  isNonNullType,
  isRequiredInputField,
} from '../../type/definition.js';

import { replaceVariables } from '../../utilities/replaceVariables.js';

import type { ValidationContext } from '../ValidationContext.js';

/**
 * Value literals of correct type
 *
 * A GraphQL document is only valid if all value literals are of the type
 * expected at their position.
 *
 * See https://spec.graphql.org/draft/#sec-Values-of-Correct-Type
 */
export function ValuesOfCorrectTypeRule(
  context: ValidationContext,
): ASTVisitor {
  let variableDefinitions: { [key: string]: VariableDefinitionNode } = {};

  return {
    OperationDefinition: {
      enter() {
        variableDefinitions = {};
      },
    },
    VariableDefinition(definition) {
      variableDefinitions[definition.variable.name.value] = definition;
    },
    ListValue(node) {
      // Note: TypeInfo will traverse into a list's item type, so look to the
      // parent input type to check if it is a list.
      const type = getNullableType(context.getParentInputType());
      if (!isListType(type)) {
        isValidValueNode(context, node);
        return false; // Don't traverse further.
      }
    },
    ObjectValue(node) {
      const type = getNamedType(context.getInputType());
      if (!isInputObjectType(type)) {
        isValidValueNode(context, node);
        return false; // Don't traverse further.
      }
      // Ensure every required field exists.
      const fieldNodeMap = new Map(
        node.fields.map((field) => [field.name.value, field]),
      );
      for (const fieldDef of Object.values(type.getFields())) {
        const fieldNode = fieldNodeMap.get(fieldDef.name);
        if (!fieldNode && isRequiredInputField(fieldDef)) {
          const typeStr = inspect(fieldDef.type);
          context.reportError(
            new GraphQLError(
              `Field "${type}.${fieldDef.name}" of required type "${typeStr}" was not provided.`,
              { nodes: node },
            ),
          );
        }
      }

      if (type.isOneOf) {
        validateOneOfInputObject(context, node, type, fieldNodeMap);
      }
    },
    ObjectField(node) {
      const parentType = getNamedType(context.getParentInputType());
      const fieldType = context.getInputType();
      if (!fieldType && isInputObjectType(parentType)) {
        const suggestions = suggestionList(
          node.name.value,
          Object.keys(parentType.getFields()),
        );
        context.reportError(
          new GraphQLError(
            `Field "${node.name.value}" is not defined by type "${parentType}".` +
              didYouMean(suggestions),
            { nodes: node },
          ),
        );
      }
    },
    NullValue(node) {
      const type = context.getInputType();
      if (isNonNullType(type)) {
        context.reportError(
          new GraphQLError(
            `Expected value of type "${inspect(type)}", found ${print(node)}.`,
            { nodes: node },
          ),
        );
      }
    },
    EnumValue: (node) => isValidValueNode(context, node),
    IntValue: (node) => isValidValueNode(context, node),
    FloatValue: (node) => isValidValueNode(context, node),
    // Descriptions are string values that would not validate according
    // to the below logic, but since (per the specification) descriptions must
    // not affect validation, they are ignored entirely when visiting the AST
    // and do not require special handling.
    // See https://spec.graphql.org/draft/#sec-Descriptions
    StringValue: (node) => isValidValueNode(context, node),
    BooleanValue: (node) => isValidValueNode(context, node),
  };
}

/**
 * Any value literal may be a valid representation of a Scalar, depending on
 * that scalar type.
 */
function isValidValueNode(context: ValidationContext, node: ValueNode): void {
  // Report any error at the full type expected by the location.
  const locationType = context.getInputType();
  if (!locationType) {
    return;
  }

  const type = getNamedType(locationType);

  if (!isLeafType(type)) {
    const typeStr = inspect(locationType);
    context.reportError(
      new GraphQLError(
        `Expected value of type "${typeStr}", found ${print(node)}.`,
        { nodes: node },
      ),
    );
    return;
  }

  // Scalars and Enums determine if a literal value is valid via parseConstLiteral(),
  // which may throw or return undefined to indicate an invalid value.
  try {
    const parseResult = type.parseConstLiteral
      ? type.parseConstLiteral(replaceVariables(node))
      : type.parseLiteral(node, undefined);
    if (parseResult === undefined) {
      const typeStr = inspect(locationType);
      context.reportError(
        new GraphQLError(
          `Expected value of type "${typeStr}", found ${print(node)}.`,
          { nodes: node },
        ),
      );
    }
  } catch (error) {
    const typeStr = inspect(locationType);
    if (error instanceof GraphQLError) {
      context.reportError(error);
    } else {
      context.reportError(
        new GraphQLError(
          `Expected value of type "${typeStr}", found ${print(node)}; ` +
            error.message,
          { nodes: node, originalError: error },
        ),
      );
    }
  }
}

function validateOneOfInputObject(
  context: ValidationContext,
  node: ObjectValueNode,
  type: GraphQLInputObjectType,
  fieldNodeMap: Map<string, ObjectFieldNode>,
): void {
  const isNotExactlyOneField = fieldNodeMap.size !== 1;

  if (isNotExactlyOneField) {
    context.reportError(
      new GraphQLError(
        `OneOf Input Object "${type}" must specify exactly one key.`,
        { nodes: [node] },
      ),
    );
    return;
  }

  const value = (fieldNodeMap.values().next().value as ObjectFieldNode).value;
  const isNullLiteral = value.kind === Kind.NULL;

  if (isNullLiteral) {
    const key = fieldNodeMap.keys().next().value as string;
    context.reportError(
      new GraphQLError(`Field "${type.name}.${key}" must be non-null.`, {
        nodes: [node],
      }),
    );
  }
}
