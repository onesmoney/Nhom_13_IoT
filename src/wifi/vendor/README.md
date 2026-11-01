# Vendored Pico CSS

- Package: `@picocss/pico`, pinned to **2.1.1**.
- Upstream: https://github.com/picocss/pico
- Official npm package: https://www.npmjs.com/package/@picocss/pico/v/2.1.1
- Source tarball: https://registry.npmjs.org/@picocss/pico/-/pico-2.1.1.tgz
- Source asset: `package/css/pico.min.css` (package-relative `css/pico.min.css`).
- Original asset size: **83,319 bytes**, excluding the C++ terminating NUL.
- Asset SHA-256: `fbc9a63fc9fc9f72d12fd7fc9806e11fa9f77ae4f9cad146b27003a1119ba3db`.
- npm tarball integrity (SHA-512): `sha512-kIDugA7Ps4U+2BHxiNHmvgPIQDWPDU4IeU6TNRdvXQM1uZX+FibqDQT2xUOnnO2yq/LUHcwnGlu1hvf4KfXnMg==`.

## Files and license

`PicoCss.h` declares `WifiPortal::kPicoCss`. `PicoCss.cpp` embeds the official
minified CSS byte-for-byte in a C++ raw string stored with `PROGMEM`; it does not
add leading or trailing whitespace to the asset. The C++ array also includes its
normal terminating NUL. No package scripts or CSS rebuild are needed.

Pico CSS is MIT licensed, copyright (c) 2019-2024 Pico. `LICENSE.pico` is an
unmodified copy of the package's `package/LICENSE.md`. The original CSS license
banner is retained inside the embedded asset.

## Refresh

1. Choose an explicit package version (never a floating `latest`), retrieve its
   metadata from the official npm registry, and download the tarball into a new,
   empty temporary directory outside this project.
2. Verify the archive against the version metadata's `dist.integrity`. Inspect
   archive entries before extracting only regular files `package/package.json`,
   `package/LICENSE.md`, and `package/css/pico.min.css` into a separate new, empty
   temporary extraction directory. Do not run package scripts or install package
   dependencies. If using Python for archive handling, run `python -I` from
   outside the archive/extraction directories.
3. Check the package name and version and read the upstream license. Replace
   `LICENSE.pico` with the exact upstream license bytes.
4. Regenerate only the raw string payload in `PicoCss.cpp` from the original CSS
   bytes. Keep the `PicoCss.h` and `<pgmspace.h>` includes and the definition
   `const char kPicoCss[] PROGMEM` inside namespace `WifiPortal`. Ensure the chosen
   raw string closing delimiter (currently `)PICO_CSS"`) does not occur in the
   CSS, and do not introduce newlines inside the payload boundaries.
5. Compare the embedded payload byte-for-byte with the extracted CSS. Update the
   version, URLs, original size, SHA-256, tarball integrity, and license details
   above. Copy only these curated vendor files into the project; keep the source
   distribution and temporary extraction outside it.
