export interface OrderedConcurrentMapOptions {
  readonly signal?: AbortSignal
  readonly canceledError?: () => Error
}

export interface OrderedConcurrentMapper {
  readonly concurrency: number
  map<Input, Output>(
    items: readonly Input[],
    options: OrderedConcurrentMapOptions,
    operation: (item: Input, index: number) => Promise<Output>
  ): AsyncGenerator<Output>
}

type Settled<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: unknown }
type Completed<Value> = { readonly result: Settled<Value>; readonly releaseRecord: () => void }

export function createOrderedConcurrentMapper(value: number): OrderedConcurrentMapper {
  const concurrency = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
  const operations = createSemaphore(concurrency)
  const records = createRecordBudget(concurrency * 4)

  const map = async function* <Input, Output>(
    items: readonly Input[],
    options: OrderedConcurrentMapOptions,
    operation: (item: Input, index: number) => Promise<Output>
  ): AsyncGenerator<Output> {
    const pending = new Map<number, Promise<Completed<Output>>>()
    let nextToAdmit = 0
    const canceledError = (): Error => options.canceledError?.() ?? new Error("Operation canceled")

    const schedule = (index: number, releaseRecord: () => void): void => {
      nextToAdmit = index + 1
      pending.set(index, (async (): Promise<Completed<Output>> => {
        let releaseOperation: (() => void) | undefined
        try {
          if (options.signal?.aborted) throw canceledError()
          releaseOperation = await operations.acquire()
          if (options.signal?.aborted) throw canceledError()
          return { result: { ok: true, value: await operation(items[index]!, index) }, releaseRecord }
        } catch (error) {
          return { result: { ok: false, error }, releaseRecord }
        } finally {
          releaseOperation?.()
        }
      })())
    }

    const fillWindow = (): void => {
      while (nextToAdmit < items.length && pending.size < concurrency && !options.signal?.aborted) {
        const releaseRecord = records.tryAcquireExtra()
        if (!releaseRecord) return
        schedule(nextToAdmit, releaseRecord)
      }
    }

    const ensureRequired = async (index: number): Promise<void> => {
      if (pending.has(index) || options.signal?.aborted) return
      schedule(index, await records.acquireRequired())
      fillWindow()
    }

    const drain = async (): Promise<void> => {
      await Promise.all([...pending.values()].map(async (completed) => { (await completed).releaseRecord() }))
      pending.clear()
    }

    try {
      for (let index = 0; index < items.length; index += 1) {
        if (options.signal?.aborted) throw canceledError()
        await ensureRequired(index)
        const completed = pending.get(index)
        if (!completed) throw new Error("Ordered concurrent mapper stopped admission")
        const { result, releaseRecord } = await completed
        pending.delete(index)
        releaseRecord()
        if (!result.ok) throw result.error
        if (options.signal?.aborted) throw canceledError()
        yield result.value
        fillWindow()
      }
    } finally {
      await drain()
    }
  }

  return { concurrency, map }
}

interface Semaphore { acquire(): Promise<() => void> }

function createSemaphore(limit: number): Semaphore {
  let available = Math.max(1, Math.floor(limit))
  const waiting: Array<(release: () => void) => void> = []
  const release = (): void => {
    const next = waiting.shift()
    if (next) next(once(release))
    else available += 1
  }
  return {
    acquire: () => {
      if (available > 0) {
        available -= 1
        return Promise.resolve(once(release))
      }
      return new Promise((resolve) => waiting.push(resolve))
    }
  }
}

interface RecordBudget {
  acquireRequired(): Promise<() => void>
  tryAcquireExtra(): (() => void) | undefined
}

function createRecordBudget(limit: number): RecordBudget {
  let available = Math.max(2, Math.floor(limit))
  const required: Array<(release: () => void) => void> = []
  const release = (): void => {
    const next = required.shift()
    if (next) next(once(release))
    else available += 1
  }
  const take = (): (() => void) => {
    available -= 1
    return once(release)
  }
  return {
    acquireRequired: () => available > 0
      ? Promise.resolve(take())
      : new Promise((resolve) => required.push(resolve)),
    // Keep one record available for a nested or concurrent consumer's next
    // required result. Speculative window filling must never consume it.
    tryAcquireExtra: () => available > 1 ? take() : undefined
  }
}

function once(operation: () => void): () => void {
  let called = false
  return () => {
    if (called) return
    called = true
    operation()
  }
}
