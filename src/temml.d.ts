declare module 'temml' {
  interface TemmlOptions {
    displayMode?: boolean
    annotate?: boolean
    throwOnError?: boolean
    macros?: Record<string, string>
  }
  const temml: {
    renderToString(tex: string, options?: TemmlOptions): string
  }
  export default temml
}
