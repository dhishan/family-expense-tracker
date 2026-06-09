module.exports = function (api) {
  // Use api.cache.using so we can vary config by environment
  const isTest = process.env.NODE_ENV === 'test'
  api.cache(() => isTest)

  return {
    presets: [
      isTest
        ? 'babel-preset-expo'
        : ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
    ],
    plugins: isTest ? [] : ['nativewind/babel'],
  }
}
