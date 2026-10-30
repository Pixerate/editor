// Vite's `?worker` imports (the demo doesn't load `vite/client` types).
declare module '*?worker' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
