module.exports = function (api) {
  // Use api.cache.using so we can vary config by environment
  const isTest = process.env.NODE_ENV === 'test'
  api.cache(() => isTest)

  if (isTest) {
    return {
      presets: ['babel-preset-expo'],
    }
  }

  return {
    // NativeWind v4: `nativewind/babel` returns a preset object (with
    // `plugins: [...]`), so it must go in `presets:`, not `plugins:`.
    // Putting it under `plugins` triggers Babel's
    // `.plugins is not a valid Plugin property` error.
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    plugins: [
      // Reanimated 3 REQUIRES this plugin and it MUST be the last entry
      // in the plugins array. Without it, worklet objects get compiled
      // as broken Hermes bytecode — Debug builds appear to work because
      // the JS engine interprets the source at runtime, but Release
      // builds crash on first JS event-loop tick with a SIGSEGV in
      // Hermes during initial runtime setup (debugJavaScript). Was
      // missing since the original mobile app scaffold.
      'react-native-reanimated/plugin',
    ],
  }
}
