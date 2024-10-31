import { expect } from 'chai';
import { describe, it } from 'mocha';

import { expectJSON } from '../../__testUtils__/expectJSON.js';
import { resolveOnNextTick } from '../../__testUtils__/resolveOnNextTick.js';

import { parse } from '../../language/parser.js';

import { buildSchema } from '../../utilities/buildASTSchema.js';

import { execute, subscribe } from '../execute.js';

const schema = buildSchema(`
  type Todo {
    id: ID
    items: [String]
    author: User
  }

  type User {
    id: ID
    name: String
  }

  type Query {
    todo: Todo
    nonNullableTodo: Todo!
  }

  type Mutation {
    foo: String
    bar: String
  }

  type Subscription {
    foo: String
  }
`);

describe('Execute: Cancellation', () => {
  it('should stop the execution when aborted during object field completion', async () => {
    const abortController = new AbortController();
    const document = parse(`
      query {
        todo {
          id
          author {
            id
          }
        }
      }
    `);

    const resultPromise = execute({
      document,
      schema,
      abortSignal: abortController.signal,
      rootValue: {
        todo: async () =>
          Promise.resolve({
            id: '1',
            /* c8 ignore next */
            author: () => expect.fail('Should not be called'),
          }),
      },
    });

    abortController.abort();

    const result = await resultPromise;

    expect(result.errors?.[0].originalError?.name).to.equal('AbortError');

    expectJSON(result).toDeepEqual({
      data: {
        todo: null,
      },
      errors: [
        {
          message: 'This operation was aborted',
          path: ['todo'],
          locations: [{ line: 3, column: 9 }],
        },
      ],
    });
  });

  it('should provide access to the abort signal within resolvers', async () => {
    const abortController = new AbortController();
    const document = parse(`
      query {
        todo {
          id
        }
      }
    `);

    const cancellableAsyncFn = async (abortSignal: AbortSignal) => {
      await resolveOnNextTick();
      abortSignal.throwIfAborted();
    };

    const resultPromise = execute({
      document,
      schema,
      abortSignal: abortController.signal,
      rootValue: {
        todo: {
          id: (_args: any, _context: any, _info: any, signal: AbortSignal) =>
            cancellableAsyncFn(signal),
        },
      },
    });

    abortController.abort();

    const result = await resultPromise;

    expectJSON(result).toDeepEqual({
      data: {
        todo: {
          id: null,
        },
      },
      errors: [
        {
          message: 'This operation was aborted',
          path: ['todo', 'id'],
          locations: [{ line: 4, column: 11 }],
        },
      ],
    });
  });

  it('should stop the execution when aborted during object field completion with a custom error', async () => {
    const abortController = new AbortController();
    const document = parse(`
      query {
        todo {
          id
          author {
            id
          }
        }
      }
    `);

    const resultPromise = execute({
      document,
      schema,
      abortSignal: abortController.signal,
      rootValue: {
        todo: async () =>
          Promise.resolve({
            id: '1',
            /* c8 ignore next */
            author: () => expect.fail('Should not be called'),
          }),
      },
    });

    const customError = new Error('Custom abort error');
    abortController.abort(customError);

    const result = await resultPromise;

    expect(result.errors?.[0].originalError).to.equal(customError);

    expectJSON(result).toDeepEqual({
      data: {
        todo: null,
      },
      errors: [
        {
          message: 'Custom abort error',
          path: ['todo'],
          locations: [{ line: 3, column: 9 }],
        },
      ],
    });
  });

  it('should stop the execution when aborted during object field completion with a custom string', async () => {
    const abortController = new AbortController();
    const document = parse(`
      query {
        todo {
          id
          author {
            id
          }
        }
      }
    `);

    const resultPromise = execute({
      document,
      schema,
      abortSignal: abortController.signal,
      rootValue: {
        todo: async () =>
          Promise.resolve({
            id: '1',
            /* c8 ignore next */
            author: () => expect.fail('Should not be called'),
          }),
      },
    });

    abortController.abort('Custom abort error message');

    const result = await resultPromise;

    expectJSON(result).toDeepEqual({
      data: {
        todo: null,
      },
      errors: [
        {
          message: 'Unexpected error value: "Custom abort error message"',
          path: ['todo'],
          locations: [{ line: 3, column: 9 }],
        },
      ],
    });
  });

  it('should stop the execution when aborted during nested object field completion', async () => {
    const abortController = new AbortController();
    const document = parse(`
      query {
        todo {
          id
          author {
            id
          }
        }
      }
    `);

    const resultPromise = execute({
      document,
      schema,
      abortSignal: abortController.signal,
      rootValue: {
        todo: {
          id: '1',
          /* c8 ignore next 3 */
          author: async () =>
            Promise.resolve(() => expect.fail('Should not be called')),
        },
      },
    });

    abortController.abort();

    const result = await resultPromise;

    expectJSON(result).toDeepEqual({
      data: {
        todo: {
          id: '1',
          author: null,
        },
      },
      errors: [
        {
          message: 'This operation was aborted',
          path: ['todo', 'author'],
          locations: [{ line: 5, column: 11 }],
        },
      ],
    });
  });

  it('should stop the execution when aborted despite a hanging resolver', async () => {
    const abortController = new AbortController();
    const document = parse(`
      query {
        todo {
          id
          author {
            id
          }
        }
      }
    `);

    const resultPromise = execute({
      document,
      schema,
      abortSignal: abortController.signal,
      rootValue: {
        todo: () =>
          new Promise(() => {
            /* will never resolve */
          }),
      },
    });

    abortController.abort();

    const result = await resultPromise;

    expect(result.errors?.[0].originalError?.name).to.equal('AbortError');

    expectJSON(result).toDeepEqual({
      data: {
        todo: null,
      },
      errors: [
        {
          message: 'This operation was aborted',
          path: ['todo'],
          locations: [{ line: 3, column: 9 }],
        },
      ],
    });
  });

  it('should stop the execution when aborted despite a hanging item', async () => {
    const abortController = new AbortController();
    const document = parse(`
      query {
        todo {
          id
          items
        }
      }
    `);

    const resultPromise = execute({
      document,
      schema,
      abortSignal: abortController.signal,
      rootValue: {
        todo: () => ({
          id: '1',
          items: [
            new Promise(() => {
              /* will never resolve */
            }),
          ],
        }),
      },
    });

    abortController.abort();

    const result = await resultPromise;

    expect(result.errors?.[0].originalError?.name).to.equal('AbortError');

    expectJSON(result).toDeepEqual({
      data: {
        todo: {
          id: '1',
          items: [null],
        },
      },
      errors: [
        {
          message: 'This operation was aborted',
          path: ['todo', 'items', 0],
          locations: [{ line: 5, column: 11 }],
        },
      ],
    });
  });

  it('should stop the execution when aborted with proper null bubbling', async () => {
    const abortController = new AbortController();
    const document = parse(`
      query {
        nonNullableTodo {
          id
          author {
            id
          }
        }
      }
    `);

    const resultPromise = execute({
      document,
      schema,
      abortSignal: abortController.signal,
      rootValue: {
        nonNullableTodo: async () =>
          Promise.resolve({
            id: '1',
            /* c8 ignore next */
            author: () => expect.fail('Should not be called'),
          }),
      },
    });

    abortController.abort();

    const result = await resultPromise;

    expect(result.errors?.[0].originalError?.name).to.equal('AbortError');

    expectJSON(result).toDeepEqual({
      data: null,
      errors: [
        {
          message: 'This operation was aborted',
          path: ['nonNullableTodo'],
          locations: [{ line: 3, column: 9 }],
        },
      ],
    });
  });

  it('should stop the execution when aborted mid-mutation', async () => {
    const abortController = new AbortController();
    const document = parse(`
      mutation {
        foo
        bar
      }
    `);

    const resultPromise = execute({
      document,
      schema,
      abortSignal: abortController.signal,
      rootValue: {
        foo: async () => Promise.resolve('baz'),
        /* c8 ignore next */
        bar: () => expect.fail('Should not be called'),
      },
    });

    await resolveOnNextTick();
    await resolveOnNextTick();
    await resolveOnNextTick();

    abortController.abort();

    const result = await resultPromise;

    expectJSON(result).toDeepEqual({
      data: {
        foo: 'baz',
        bar: null,
      },
      errors: [
        {
          message: 'This operation was aborted',
          path: ['bar'],
          locations: [{ line: 4, column: 9 }],
        },
      ],
    });
  });

  it('should stop the execution when aborted pre-execute', async () => {
    const abortController = new AbortController();
    const document = parse(`
      query {
        todo {
          id
          author {
            id
          }
        }
      }
    `);
    abortController.abort();
    const result = await execute({
      document,
      schema,
      abortSignal: abortController.signal,
      rootValue: {
        /* c8 ignore next */
        todo: () => expect.fail('Should not be called'),
      },
    });

    expectJSON(result).toDeepEqual({
      errors: [
        {
          message: 'This operation was aborted',
        },
      ],
    });
  });

  it('should stop the execution when aborted during subscription', async () => {
    const abortController = new AbortController();
    const document = parse(`
      subscription {
        foo
      }
    `);

    const resultPromise = subscribe({
      document,
      schema,
      abortSignal: abortController.signal,
      rootValue: {
        foo: async () =>
          new Promise(() => {
            /* will never resolve */
          }),
      },
    });

    abortController.abort();

    const result = await resultPromise;

    expectJSON(result).toDeepEqual({
      errors: [
        {
          message: 'This operation was aborted',
          path: ['foo'],
          locations: [{ line: 3, column: 9 }],
        },
      ],
    });
  });
});
