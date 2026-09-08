// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist/**', 'coverage/**', 'generated/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // ⚠️ Condition B2. `Date.UTC` maps a `year` argument in [0, 99] to `1900 + year`
    // (ECMAScript `MakeFullYear`); Python's `datetime.date` and `strptime` do not. That
    // divergence was silent -- `end_date: "0050-06-15"` answered 200 on BOTH stacks and stored
    // a different year -- and one of its forms wrote a row v1 would never have created.
    //
    // The first fix round routed four call sites through `utcMillisFromParts` and wrote
    // "every `Date.UTC` call in this codebase must go through here" in a docblock. FOUR MORE
    // SITES were live at that moment: `parseBirthdate` and `strptimeIsoDate` (both reachable,
    // both v1 200 / v2 500 for a two-digit year) and two in `relativedelta.util.ts`. The prose
    // invariant was false the day it was written, and nothing could tell us.
    //
    // This rule is that same claim in the only form that cannot go stale.
    // Production paths only. Spec files legitimately construct fixtures with literal
    // four-digit years, and the B2 cells deliberately name the raw behaviour they pin.
    files: ['src/**/*.ts'],
    ignores: ['src/common/utils/date.util.ts', 'src/**/*.spec.ts'],
    rules: {
      // ⚠️ FOUR selectors, not one. The first version of this rule banned `Date.UTC(...)`
      // and nothing else, and the control recorded for it -- "a fresh raw Date.UTC reports
      // exactly one error" -- proved the rule FIRES, not that the class is CLOSED. That is
      // C67 one level up: a control that exercises only the case you already thought of.
      // `nestjs-reviewer` planted five bypass forms and four of them passed clean.
      //
      // `new Date(y, m, d)` is the important one: it runs the same `MakeFullYear`
      // (measured: `new Date(50,0,1).getFullYear() === 1950`), it is the MORE idiomatic
      // spelling, and it carries a local-time-zone bug on top. The single-argument forms
      // (`new Date(millis)`, `new Date(iso)`, `new Date()`) are untouched.
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='Date'][property.name='UTC']",
          message:
            'Use utcMillisFromParts from src/common/utils/date.util.ts. Raw Date.UTC maps years 0-99 to 1900+year, which datetime.date does not (condition B2).',
        },
        {
          selector: "MemberExpression[object.name='Date'][property.value='UTC']",
          message:
            "Date['UTC'] is Date.UTC spelled differently, and carries the same years 0-99 remap (B2). Use utcMillisFromParts.",
        },
        {
          selector: "VariableDeclarator[init.name='Date']",
          message:
            'Aliasing or destructuring Date defeats the Date.UTC ban (B2). Use utcMillisFromParts from src/common/utils/date.util.ts.',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length>=2]",
          message:
            'new Date(y, m, d) runs the same MakeFullYear remap as Date.UTC (years 0-99 become 1900+year) AND interprets the parts in the local time zone. Use utcMillisFromParts (B2).',
        },
      ],
    },
  },
);
