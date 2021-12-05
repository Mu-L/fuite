import puppeteer from 'puppeteer'
import * as HeapSnapshotWorker from './thirdparty/devtools/heap_snapshot_worker/heap_snapshot_worker.js'
import * as HeapSnapshotModel from './thirdparty/devtools/heap_snapshot_worker/heap_snapshot_model.js'
import * as defaultScenario from './defaultScenario.js'
import { createReadStream, createWriteStream } from 'fs'
import path from 'path'
import tempDirectory from 'temp-dir'
import cryptoRandomString from 'crypto-random-string'
import { mkdir } from 'fs/promises'

const ITERATIONS = 7

let tempDir

async function writeSnapshot (page) {
  if (!tempDir) {
    tempDir = path.join(tempDirectory, `fuite-${cryptoRandomString({ length: 16 })}`)
    await mkdir(tempDir)
  }
  const tmpFile = path.join(tempDir, `heapsnap-${cryptoRandomString({ length: 16 })}.json`)
  console.log('tmpFile', tmpFile)
  const cdpSession = await page.target().createCDPSession()
  let writeStream
  const writeStreamPromise = new Promise((resolve, reject) => {
    writeStream = createWriteStream(tmpFile, { encoding: 'utf8' })
    writeStream.on('error', reject)
    writeStream.on('finish', () => resolve())
  })
  const heapProfilerPromise = new Promise(resolve => {
    cdpSession.on('HeapProfiler.reportHeapSnapshotProgress', ({ finished }) => {
      if (finished) {
        resolve()
      }
    })
  })
  await cdpSession.send('HeapProfiler.enable')
  await cdpSession.send('HeapProfiler.collectGarbage')
  cdpSession.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => {
    writeStream.write(chunk)
  })
  await cdpSession.send('HeapProfiler.takeHeapSnapshot', {
    reportProgress: true
  })

  await heapProfilerPromise
  await cdpSession.detach()
  writeStream.close()
  await writeStreamPromise
  return tmpFile
}

async function readSnapshot (tmpFile) {
  let loader
  const loaderPromise = new Promise(resolve => {
    loader = new HeapSnapshotWorker.HeapSnapshotLoader.HeapSnapshotLoader({
      sendEvent (type, message) {
        if (message === 'Parsing strings…') {
          // queue microtask to wait for data to truly be written
          Promise.resolve().then(resolve)
        }
      }
    })
  })
  let readStream
  const readStreamPromise = new Promise((resolve, reject) => {
    readStream = createReadStream(tmpFile, { encoding: 'utf8' })
    readStream.on('error', reject)
    readStream.on('end', () => resolve())
    readStream.on('data', chunk => {
      loader.write(chunk)
    })
  })
  await readStreamPromise

  loader.close()
  await loaderPromise

  return (await loader.buildSnapshot())
}

async function takeHeapSnapshot (page) {
  const filename = await writeSnapshot(page)
  const snapshot = await readSnapshot(filename)
  return { filename, snapshot }
}

async function runOnPage (browser, pageUrl, beforeStep, runnable) {
  const page = await browser.newPage()

  try {
    await page.goto(pageUrl)
    await page.waitForNetworkIdle()
    if (beforeStep) {
      await beforeStep(page)
      await page.waitForNetworkIdle()
    }
    return (await runnable(page))
  } finally {
    await page.close()
  }
}

export async function findLeaks (pageUrl, options = {}) {
  const browser = await puppeteer.launch({
    headless: !options.debug
  })

  if (options.signal) {
    options.signal.addEventListener('abort', () => {
      browser.close()
    })
  }
  let scenario
  if (options.scenario) {
    scenario = await import(path.join(process.cwd(), options.scenario))
  } else {
    scenario = defaultScenario
  }

  const beforeStep = scenario.before

  const tests = await runOnPage(browser, pageUrl, beforeStep, async page => {
    return scenario.createTests(page)
  })

  try {
    const results = []
    for (const test of tests) {
      results.push(await runOnPage(browser, pageUrl, beforeStep, async page => {
        await scenario.iteration(page, test) // one throwaway iteration to avoid measuring one-time setup costs
        const { snapshot: startSnapshot, filename: startFilename } = await takeHeapSnapshot(page)
        if (options.debug) {
          debugger // "before" point in time
        }
        const startSize = startSnapshot.statistics.total
        for (let i = 0; i < ITERATIONS; i++) {
          await scenario.iteration(page, test)
        }
        const { snapshot: endSnapshot, filename: endFilename } = await takeHeapSnapshot(page)
        if (options.debug) {
          debugger // "after" point in time
        }
        const endSize = endSnapshot.statistics.total

        const aggregatesForDiff = await startSnapshot.aggregatesForDiff();
        const diffByClassName = await endSnapshot.calculateSnapshotDiff(startSnapshot.uid, aggregatesForDiff);
        const suspiciousObjects = Object.entries(diffByClassName).filter(([name, diff]) => {
          // look for objects added <iteration> times and not 0 times
          return diff.countDelta % ITERATIONS === 0 && diff.countDelta !== 0
        })
        const startAggregates = startSnapshot.aggregatesWithFilter(new HeapSnapshotModel.HeapSnapshotModel.NodeFilter())
        const endAggregates = endSnapshot.aggregatesWithFilter(new HeapSnapshotModel.HeapSnapshotModel.NodeFilter())

        const leakingObjects = suspiciousObjects.map(([name, diff]) => {
          const startAggregatesForThisClass = startAggregates[name]
          const endAggregatesForThisClass = endAggregates[name]
          return {
            name,
            diff: {...diff},
            aggregates: {
              before: {...startAggregatesForThisClass},
              after: {...endAggregatesForThisClass}
            },
            retainedSizeDelta: endAggregatesForThisClass.maxRet - startAggregatesForThisClass.maxRet,
            snapshots: {
              before: startFilename,
              after: endFilename
            }
          }
        })
        const result = {
          delta: endSize - startSize,
          before: { statistics: { ...startSnapshot.statistics } },
          after: { statistics: { ...endSnapshot.statistics } },
          leakingObjects
        }

        return {
          test,
          result
        }
      }))
    }
    return results
  } finally {
    console.log('closing in finally block')
    await browser.close()
    console.log('closed in finally block')
  }
}