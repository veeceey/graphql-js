const assert = require('assert');
const { readFileSync } = require('fs');

const { graphqlSync } = require('graphql');
const { astFromValue, buildSchema } = require('graphql/utilities');
const { version } = require('graphql/version');

assert.deepStrictEqual(
  version,
  JSON.parse(readFileSync('./node_modules/graphql/package.json')).version,
);

const schema = buildSchema('type Query { hello: String }');

let result = graphqlSync({
  schema,
  source: '{ hello }',
  rootValue: { hello: 'world' },
});

assert.deepStrictEqual(result, {
  data: {
    __proto__: null,
    hello: 'world',
  },
});

/**
 * The below test triggers a call to the `invariant` utility (by passing
 * an invalid value to astFromValue). This ensures that the
 * `inlineInvariant` function called by our build script works correctly.
 **/

assert.throws(() => astFromValue(true, undefined), 'Unexpected input type: ');
