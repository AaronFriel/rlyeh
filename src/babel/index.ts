import { Node, PluginObj } from 'babel-core';

// @ts-ignore
const replaced = Symbol('replaced');

const buildNewClassProperty = (
  t,
  classPropertyName,
  newMethodName,
  isAsync,
) => {
  let returnExpression = t.callExpression(
    t.memberExpression(t.thisExpression(), newMethodName),
    [t.spreadElement(t.identifier('params'))],
  );

  if (isAsync) {
    returnExpression = t.awaitExpression(returnExpression);
  }

  const newArrowFunction = t.arrowFunctionExpression(
    [t.restElement(t.identifier('params'))],
    returnExpression,
    isAsync,
  );
  return t.classProperty(classPropertyName, newArrowFunction);
};

const buildNewAssignmentExpression = (
  t,
  classPropertyName,
  newMethodName,
  isAsync,
) => {
  let returnExpression = t.callExpression(
    t.memberExpression(t.thisExpression(), newMethodName),
    [t.spreadElement(t.identifier('params'))],
  );

  if (isAsync) {
    returnExpression = t.awaitExpression(returnExpression);
  }

  const newArrowFunction = t.arrowFunctionExpression(
    [t.restElement(t.identifier('params'))],
    returnExpression,
    isAsync,
  );
  const left = t.memberExpression(
    t.thisExpression(),
    t.identifier(classPropertyName.name),
  );

  const replacement = t.assignmentExpression('=', left, newArrowFunction);
  replacement[replaced] = true;

  return replacement;
};

const classPropertyOptOutVistor = {
  MetaProperty(path, state) {
    const { node } = path;

    if (node.meta.name === 'new' && node.property.name === 'target') {
      state.optOut = true; // eslint-disable-line no-param-reassign
    }
  },

  ReferencedIdentifier(path, state) {
    const { node } = path;

    if (node.name === 'arguments') {
      state.optOut = true; // eslint-disable-line no-param-reassign
    }
  },
};

module.exports = function plugin(args): PluginObj<Node> {
// This is a Babel plugin, but the user put it in the Webpack config.
  if (this && this.callback) {
    throw new Error(
      'Rlyeh: You are erroneously trying to use a Babel plugin ' +
        'as a Webpack loader. We recommend that you use Babel, ' +
        'remove "rlyeh/lib/babel-plugin" from the "loaders" section ' +
        'of your Webpack configuration, and instead add ' +
        '"rlyeh/lib/babel-plugin" to the "plugins" section of your .babelrc file. ' +
        'If you prefer not to use Babel, replace "rlyeh/lib/babel-plugin" with ' +
        '"rlyeh/lib/webpack" in the "loaders" section of your Webpack configuration. ',
    );
  }
  const { types: t, template } = args;

  const buildRegistration = template(
    '__RLYEH__.register(ID, NAME, FILENAME);',
  );

  // We're making the IIFE we insert at the end of the file an unused variable
  // because it otherwise breaks the output of the babel-node REPL (#359).
  const buildTagger = template(`
  var UNUSED = (function () {
    if (typeof __RLYEH__ === 'undefined') {
      return;
    }

    REGISTRATIONS
  })();
  `);

  // No-op in production.
  if (process.env.NODE_ENV === 'production') {
    return { visitor: {} };
  }

  // Gather top-level variables, functions, and classes.
  // Try our best to avoid variables from require().
  // Ideally we only want to find components defined by the user.
  function shouldRegisterBinding(binding) {
    const { type, node } = binding.path;
    switch (type) {
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
      case 'VariableDeclaration':
        return true;
      case 'VariableDeclarator': {
        const { init } = node;
        if (t.isCallExpression(init) && init.callee.name === 'require') {
          return false;
        }
        return true;
      }
      default:
        return false;
    }
  }

  // @ts-ignore
  const REGISTRATIONS = Symbol('registrations');
  return {
    visitor: {
      ExportDefaultDeclaration(path, { file }) {
        // Default exports with names are going
        // to be in scope anyway so no need to bother.
        if (path.node.declaration.hasOwnProperty('id')) {
          return;
        }

        // Move export default right hand side to a variable
        // so we can later refer to it and tag it with __source.
        const id = path.scope.generateUidIdentifier('default');
        const expression = t.isExpression(path.node.declaration)
          ? path.node.declaration
          : t.toExpression(path.node.declaration);
        path.insertBefore(
          t.variableDeclaration('const', [
            t.variableDeclarator(id, expression),
          ]),
        );
        path.node.declaration = id; // eslint-disable-line no-param-reassign

        // It won't appear in scope.bindings
        // so we'll manually remember it exists.
        path.parent[REGISTRATIONS].push(
          buildRegistration({
            FILENAME: t.stringLiteral(file.opts.filename),
            ID: id,
            NAME: t.stringLiteral('default'),
          }),
        );
      },

      Program: {
        enter({ node, scope }, { file }) {
          node[REGISTRATIONS] = []; // eslint-disable-line no-param-reassign

          // Everything in the top level scope, when reasonable,
          // is going to get tagged with __source.
          // tslint:disable-next-line:forin
          for (const id in scope.bindings) {
            const binding = scope.bindings[id];
            if (shouldRegisterBinding(binding)) {
              node[REGISTRATIONS].push(
                buildRegistration({
                  FILENAME: t.stringLiteral(file.opts.filename),
                  ID: binding.identifier,
                  NAME: t.stringLiteral(id),
                }),
              );
            }
          }
          /* eslint-enable */
        },

        exit({ node, scope }) {
          const registrations = node[REGISTRATIONS];
          node[REGISTRATIONS] = null; // eslint-disable-line no-param-reassign

          // Inject the generated tagging code at the very end
          // so that it is as minimally intrusive as possible.
          // @ts-ignore
          node.body.push(t.emptyStatement());
          // @ts-ignore
          node.body.push(
            buildTagger({
              REGISTRATIONS: registrations,
              UNUSED: scope.generateUidIdentifier(),
            }),
          );
          // @ts-ignore
          node.body.push(t.emptyStatement());
        },
      },
      Class(classPath) {
        const classBody = classPath.get('body');

        // @ts-ignore
        classBody.get('body').forEach((path) => {
          if (path.isClassProperty()) {
            const { node } = path;

            // don't apply transform to static class properties
            if (node.static) {
              return;
            }

            const state = {
              optOut: false,
            };

            path.traverse(classPropertyOptOutVistor, state);

            if (state.optOut) {
              return;
            }

            // class property node value is nullable
            if (node.value && node.value.type === 'ArrowFunctionExpression') {
              const isAsync = node.value.async;

              // TODO:
              // Remove this check when babel issue is resolved: https://github.com/babel/babel/issues/5078
              // RHL Issue: https://github.com/gaearon/react-hot-loader/issues/391
              // This code makes async arrow functions not reloadable,
              // but doesn't break code any more when using 'this' inside AAF
              if (isAsync) {
                return;
              }

              const { params } = node.value;
              const newIdentifier = t.identifier(
                `__${node.key.name}__RLYEH__`,
              );

              // arrow function body can either be a block statement or a returned expression
              const newMethodBody =
                node.value.body.type === 'BlockStatement'
                  ? node.value.body
                  : t.blockStatement([t.returnStatement(node.value.body)]);

              // create a new method on the class that the original class property function
              // calls, since the method is able to be replaced by RHL
              const newMethod = t.classMethod(
                'method',
                newIdentifier,
                params,
                newMethodBody,
              );
              newMethod.async = isAsync;
              path.insertAfter(newMethod);

              // replace the original class property function with a function that calls
              // the new class method created above
              path.replaceWith(
                buildNewClassProperty(t, node.key, newIdentifier, isAsync),
              );
            }
          } else if (!path.node[replaced] && path.node.kind === 'constructor') {
            path.traverse({
              AssignmentExpression(exp) {
                if (
                  !exp.node[replaced] &&
                  exp.node.left.type === 'MemberExpression' &&
                  exp.node.left.object.type === 'ThisExpression' &&
                  exp.node.right.type === 'ArrowFunctionExpression'
                ) {
                  const key = exp.node.left.property;
                  const node = exp.node.right;

                  const isAsync = node.async;
                  const { params } = node;
                  const newIdentifier = t.identifier(
                    `__${key.name}__RLYEH__`,
                  );

                  // arrow function body can either be a block statement or a returned expression
                  const newMethodBody =
                    node.body.type === 'BlockStatement'
                      ? node.body
                      : t.blockStatement([t.returnStatement(node.body)]);

                  const newMethod = t.classMethod(
                    'method',
                    newIdentifier,
                    params,
                    newMethodBody,
                  );
                  newMethod.async = isAsync;
                  newMethod[replaced] = true;
                  path.insertAfter(newMethod);

                  // replace assignment exp
                  exp.replaceWith(
                    buildNewAssignmentExpression(
                      t,
                      key,
                      newIdentifier,
                      isAsync,
                    ),
                  );
                }
              },
            });
          }
        });
      },
    },
  };
};
