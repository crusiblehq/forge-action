import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'
import type { RollupOptions } from 'rollup'

// One self-contained ESM bundle, committed as dist/index.js (the file `runs.main` names).
const config: RollupOptions = {
  input: 'src/main.ts',
  output: {
    esModule: true,
    file: 'dist/index.js',
    format: 'es',
    sourcemap: true,
    inlineDynamicImports: true
  },
  // Vendored @actions/* code triggers THIS_IS_UNDEFINED and circular-import noise that is not ours.
  onwarn(w, warn) {
    if (
      (w.id ?? w.ids?.[0])?.includes('node_modules') &&
      (w.code === 'THIS_IS_UNDEFINED' || w.code === 'CIRCULAR_DEPENDENCY')
    )
      return
    warn(w)
  },
  plugins: [
    typescript({
      tsconfig: './tsconfig.json',
      noEmit: false,
      declaration: false,
      outDir: 'dist',
      include: ['src/**/*.ts']
    }),
    nodeResolve({ preferBuiltins: true, exportConditions: ['node'] }),
    commonjs(),
    json()
  ]
}

export default config
