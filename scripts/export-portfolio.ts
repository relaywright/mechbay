/** Encode verified captures. Pass --portfolio <directory> to refresh a portfolio checkout. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'artifacts', 'portfolio')
const recording = JSON.parse(readFileSync(join(output, 'recording.json'), 'utf8')) as {
  frames: string
  count: number
  durationMs: number
}
const portfolioArgument = process.argv.indexOf('--portfolio')
const portfolio = portfolioArgument >= 0 ? resolve(process.argv[portfolioArgument + 1]) : null
if (portfolio && !existsSync(join(portfolio, 'src', 'pages', 'portfolio.astro')))
  throw new Error('Expected a SamAlbaneseConsulting checkout')
if (!existsSync(join(output, 'verification.json')))
  throw new Error('Run the capture verification before exporting')
const ffmpeg = (args: string[]): void => {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status !== 0)
    throw new Error(result.stderr || result.error?.message || 'ffmpeg failed')
}
const media = portfolio && join(portfolio, 'public', 'media')
if (media) mkdirSync(media, { recursive: true })
for (const name of ['command', 'mission', 'debrief']) {
  const target = join(root, 'site', `screenshot-${name}.webp`)
  ffmpeg(['-i', join(output, `mechbay-${name}.png`), '-quality', '90', target])
  if (media) copyFileSync(target, join(media, `mechbay-${name}.webp`))
}
copyFileSync(join(output, 'mechbay-command.png'), join(root, 'docs', 'screenshot-bay.png'))
copyFileSync(join(output, 'mechbay-command.png'), join(root, 'site', 'screenshot-bay.png'))
if (media)
  copyFileSync(join(root, 'site', 'screenshot-command.webp'), join(media, 'mechbay-poster.webp'))

// Accelerate the captured frames to a concise 24-second walkthrough.
const inputFps = recording.count / 24
const input = ['-framerate', String(inputFps), '-i', join(recording.frames, 'frame-%05d.jpg')]
// JPEG captures use full-range color. Convert the pixels, not just the metadata:
// Windows hardware video decoders can reject the inherited full-range stream.
const filter =
  'fps=12,scale=1280:800:flags=lanczos:in_range=pc:out_range=tv,format=yuv420p,sidedata=mode=delete:type=ICC_PROFILE'
const colorOptions = ['-pix_fmt', 'yuv420p', '-color_range', 'tv']
const mp4 = join(root, 'site', 'demo.mp4')
const webm = join(root, 'site', 'demo.webm')
const passlog = join(output, 'encode-pass')
ffmpeg([
  ...input,
  '-vf',
  filter,
  '-c:v',
  'libx264',
  '-b:v',
  '190k',
  '-pass',
  '1',
  '-passlogfile',
  passlog,
  '-preset',
  'slow',
  ...colorOptions,
  '-an',
  '-f',
  'null',
  process.platform === 'win32' ? 'NUL' : '/dev/null'
])
ffmpeg([
  ...input,
  '-vf',
  filter,
  '-c:v',
  'libx264',
  '-b:v',
  '190k',
  '-pass',
  '2',
  '-passlogfile',
  passlog,
  '-preset',
  'slow',
  ...colorOptions,
  '-movflags',
  '+faststart',
  '-an',
  mp4
])
// Two passes hold VP9 to its bitrate. Single-pass constrained quality
// overshot to 680 KB once the bay gained motion effects.
const vp9 = ['-c:v', 'libvpx-vp9', '-b:v', '180k', '-passlogfile', passlog, ...colorOptions]
ffmpeg([
  ...input,
  '-vf',
  filter,
  ...vp9,
  '-pass',
  '1',
  '-an',
  '-f',
  'null',
  process.platform === 'win32' ? 'NUL' : '/dev/null'
])
ffmpeg([...input, '-vf', filter, ...vp9, '-pass', '2', '-an', webm])
for (const [file, extension] of [
  [mp4, 'mp4'],
  [webm, 'webm']
]) {
  if (statSync(file).size > 700 * 1024)
    throw new Error(`${extension} exceeds the portfolio media budget`)
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=pix_fmt,color_range',
      '-of',
      'json',
      file
    ],
    { encoding: 'utf8', windowsHide: true }
  )
  if (probe.status !== 0)
    throw new Error(probe.stderr || probe.error?.message || 'Could not verify video encoding')
  const stream = JSON.parse(probe.stdout).streams?.[0]
  if (stream?.pix_fmt !== 'yuv420p' || stream?.color_range !== 'tv')
    throw new Error(`${extension} must use 8-bit YUV 4:2:0 with limited color range`)
  if (media) copyFileSync(file, join(media, `mechbay-demo.${extension}`))
}
const gif = join(root, 'docs', 'demo.gif')
// 192 colors and Bayer scale 5 keep the README GIF under 5 MB now that the bay
// animates more and fills its panel; neither shows at 2x zoom.
ffmpeg([
  ...input,
  '-filter_complex',
  'fps=8,scale=1000:625:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=5',
  '-loop',
  '0',
  gif
])
if (statSync(gif).size > 15 * 1024 * 1024) throw new Error('GIF exceeds 15 MiB')
copyFileSync(gif, join(root, 'site', 'demo.gif'))
const fonts = join(root, 'site', 'fonts')
mkdirSync(fonts, { recursive: true })
for (const [family, weight] of [
  ['barlow-condensed', '600'],
  ['barlow', '400'],
  ['ibm-plex-mono', '400']
]) {
  const name = `${family}-latin-${weight}-normal.woff2`
  copyFileSync(join(root, 'node_modules', '@fontsource', family, 'files', name), join(fonts, name))
  copyFileSync(
    join(root, 'node_modules', '@fontsource', family, 'LICENSE'),
    join(fonts, `${family}-LICENSE.txt`)
  )
}
const manifest = {
  capturedAt: JSON.parse(readFileSync(join(output, 'verification.json'), 'utf8')).capturedAt,
  mode: 'Isolated simulation; real file edits and git-backed debrief',
  sourceSize: '1600x1000',
  videoDuration: '24 seconds; accelerated playback',
  videoEncoding: '8-bit YUV 4:2:0, limited color range; H.264 MP4 and VP9 WebM',
  screenshots: ['command', 'mission', 'debrief'],
  videoBytes: { mp4: statSync(mp4).size, webm: statSync(webm).size }
}
writeFileSync(join(root, 'site', 'capture-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
if (media)
  writeFileSync(
    join(media, 'mechbay-capture-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  )
console.log(JSON.stringify(manifest, null, 2))
