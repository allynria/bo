#!/usr/bin/env node
// Re-wrap broken inline async-IIFE try/catch fragments WITHOUT changing behavior.
import fs from 'node:fs';
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';

const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) {
  console.error('Usage: node fix-wrappers.mjs <in.js> <out.js>');
  process.exit(2);
}

const src = fs.readFileSync(inFile, 'utf8');

// --- Token-level pre-pass to mark broken tails/heads ---
let text = src;
// Mark dangling tail: "} \n catch (err) { ... } \n )"
text = text.replace(
  /}\s*\n\s*catch\s*\(\s*err\s*\)\s*\{([\s\S]{0,800}?)\}\s*\n\s*\)\s*;?/g,
  (_m, catchBody) => `__SENTINEL_DANGLING_CATCH_START__${catchBody}__SENTINEL_DANGLING_CATCH_END__`
);
// Mark bare IIFE try openings (rare); left here for safety.
text = text.replace(/\(async\s*\(\s*\)\s*=>\s*\{\s*try\s*\{\s*$/gm, '__SENTINEL_IIFE_TRY_OPEN__');

// --- Parse loosely ---
const ast = parser.parse(text, {
  sourceType: 'module',
  allowReturnOutsideFunction: true,
  errorRecovery: true,
  plugins: ['importAssertions', 'topLevelAwait', 'bigInt'],
});

function wrapWithIIFE(stmtNode, catchBodyRaw) {
  const tryBlock = t.blockStatement(Array.isArray(stmtNode) ? stmtNode : [stmtNode]);
  // Parse original catch body to keep it verbatim
  const cAst = parser.parse(`try{}catch(err){${catchBodyRaw}}`, {
    sourceType: 'module',
    errorRecovery: true,
  });
  let catchClause = null;
  traverse(cAst, {
    CatchClause(p) {
      catchClause = p.node;
      p.stop();
    },
  });
  const iife = t.callExpression(
    t.arrowFunctionExpression(
      [],
      t.blockStatement([
        t.tryStatement(
          tryBlock,
          catchClause || t.catchClause(t.identifier('err'), t.blockStatement([]))
        ),
      ]),
      true
    ),
    []
  );
  return t.expressionStatement(iife);
}

// --- Replace sentinels by wrapping the previous statement ---
traverse(ast, {
  Program(path) {
    const body = path.get('body');
    for (let i = 0; i < body.length; i++) {
      const n = body[i].node;
      if (t.isExpressionStatement(n) && t.isStringLiteral(n.expression)) {
        const v = n.expression.value;
        const s = v.indexOf('__SENTINEL_DANGLING_CATCH_START__');
        const e = v.indexOf('__SENTINEL_DANGLING_CATCH_END__');
        if (s !== -1 && e !== -1 && i > 0) {
          const catchBody = v.slice(s + 33, e); // marker length
          const prevPath = body[i - 1];
          const wrapped = wrapWithIIFE(prevPath.node, catchBody);
          prevPath.replaceWith(wrapped);
          body[i].remove();
          i--;
        }
      }
    }
  },
});

// --- Print and cleanup ---
let out = generate(ast, { compact: false, retainLines: true, comments: true }).code;
out = out.replace(/__SENTINEL_IIFE_TRY_OPEN__/g, '(async()=>{ try {');
out = out.replace(/__SENTINEL_DANGLING_CATCH_START__.*?__SENTINEL_DANGLING_CATCH_END__/gs, '');
fs.writeFileSync(outFile, out, 'utf8');
console.log('[fix-wrappers] OK');
