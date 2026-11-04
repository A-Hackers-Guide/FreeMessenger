// Builds the two files the page loads:
//   app.min.js             — the app, rewritten in 2015-era JavaScript so it
//                            runs in browsers from 2017 on
//   crypto-fallback.min.js — the encryption library for browsers without
//                            WebCrypto; it needs BigInt, so it's kept separate
//                            and loaded only when needed
import { build } from "esbuild";

await build({
  entryPoints: ["app.js"],
  outfile: "app.min.js",
  bundle: true,
  format: "iife",
  target: ["es2015", "chrome58", "firefox57", "edge18"],
  minify: true,
  legalComments: "none",
});

await build({
  entryPoints: ["crypto-fallback.js"],
  outfile: "crypto-fallback.min.js",
  bundle: true,
  format: "iife",
  target: ["es2020"],
  minify: true,
  legalComments: "eof",
});
