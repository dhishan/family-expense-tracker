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
  }
}
