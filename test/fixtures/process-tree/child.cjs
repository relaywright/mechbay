// Stands in for a stubborn tool (a watcher, a dev server) that ignores a polite stop.
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)

// Safety net: if a test fails to stop this tree, it still ends within a minute.
setTimeout(() => process.exit(0), 60_000).unref()
