/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}

// Vite serves the ZXing wasm from our own bundle; the package's own types assume an
// esbuild file loader, so the ?url specifier needs its own declaration.
declare module "zxing-wasm/reader/zxing_reader.wasm?url" {
  const url: string;
  export default url;
}
