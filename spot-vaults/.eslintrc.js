module.exports = {
  env: {
    browser: false,
    es2021: true,
    mocha: true,
    node: true,
  },
  plugins: ["@typescript-eslint", "no-only-tests", "unused-imports"],
  extends: ["standard", "plugin:prettier/recommended", "plugin:node/recommended"],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 12,
    warnOnUnsupportedTypeScriptVersion: false,
  },
  rules: {
    "node/no-unsupported-features/es-syntax": ["error", { ignores: ["modules"] }],
    "node/no-missing-import": [
      "error",
      {
        tryExtensions: [".ts", ".js", ".json"],
      },
    ],
    "node/no-unpublished-import": [
      "error",
      {
        allowModules: ["hardhat", "ethers", "@openzeppelin/upgrades-core"],
      },
    ],
    "no-only-tests/no-only-tests": "error",
    "unused-imports/no-unused-imports": "error",
    "unused-imports/no-unused-vars": ["warn", { vars: "all" }],
  },
};
