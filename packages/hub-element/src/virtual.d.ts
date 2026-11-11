// The hub's stylesheet as a string: the build (build/plugin.mjs) and the tests (vitest.config.ts) both provide this module.
declare module 'cw-hub-element:css' {
  const css: string;
  export default css;
}
