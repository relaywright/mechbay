// Stands in for an agent CLI that starts a long-running tool.
// A CommonJS fixture, so require() is the only way to load modules here.
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('child_process')
const path = require('path')

const child = spawn(process.execPath, [path.join(__dirname, 'child.cjs')], { stdio: 'ignore' })
console.log(`PARENT_PID=${process.pid}`)
console.log(`CHILD_PID=${child.pid}`)
setInterval(() => {}, 1000)

// Safety net: if a test fails to stop this tree, it still ends within a minute.
setTimeout(() => process.exit(0), 60_000).unref()
