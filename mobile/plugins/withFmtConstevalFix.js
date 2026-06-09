// Expo config plugin: patch ios/Podfile post_install to fix fmt consteval errors.
//
// React Native's bundled fmt headers (via Folly) use `consteval` template
// instantiations that Xcode 15+ / Clang 17+ reject during compilation.
// Without this patch every iOS build fails with
//   `error: call to consteval function 'fmt::basic_format_string<...>' is not a constant expression`
//
// We patch fmt/base.h after pod install to make FMT_CONSTEVAL expand to
// nothing instead of `consteval`. That patch is in the Podfile post_install,
// but `expo prebuild --clean` regenerates the Podfile from template — so this
// plugin re-injects the patch into the regenerated file.
//
// Reference: https://github.com/facebook/react-native/issues/45313
const { withDangerousMod } = require('@expo/config-plugins')
const fs = require('fs')
const path = require('path')

const PATCH_BLOCK = `
    # ---- BEGIN fmt consteval fix (injected by plugins/withFmtConstevalFix.js) ----
    fmt_base = File.join(installer.sandbox.root, 'fmt', 'include', 'fmt', 'base.h')
    if File.exist?(fmt_base)
      File.chmod(0o644, fmt_base)
      content = File.read(fmt_base)
      patched = content.gsub(
        '#  define FMT_CONSTEVAL consteval',
        '#  define FMT_CONSTEVAL  // patched for Clang compatibility',
      )
      if patched != content
        File.write(fmt_base, patched)
        puts "[fmt fix] Patched FMT_CONSTEVAL in #{fmt_base}"
      end
    end
    # ---- END fmt consteval fix ----
`

module.exports = function withFmtConstevalFix(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile')
      let contents = fs.readFileSync(podfilePath, 'utf8')

      if (contents.includes('BEGIN fmt consteval fix')) {
        return cfg // already patched
      }

      // Inject just before the closing `end` of the `post_install do |installer|` block.
      const marker = 'CODE_SIGNING_ALLOWED'
      const idx = contents.indexOf(marker)
      if (idx === -1) {
        console.warn('[withFmtConstevalFix] could not find post_install anchor in Podfile; skipping injection')
        return cfg
      }
      // Find the `end` that closes the post_install block (after the resource_bundle_targets loop).
      // The pattern in the generated Podfile is two nested `end`s; we insert right after them.
      const tailRegex = /(\n\s*end\n\s*end\n\s*end\n)/ // closes inner do | each | post_install
      const matched = contents.match(tailRegex)
      if (!matched) {
        // Fallback: inject just before the final `end\nend` of the file.
        contents = contents.replace(/\n\s*end\s*\n\s*end\s*$/, `\n${PATCH_BLOCK}  end\nend\n`)
      } else {
        contents = contents.replace(tailRegex, `$1${PATCH_BLOCK}`)
      }

      fs.writeFileSync(podfilePath, contents)
      return cfg
    },
  ])
}
