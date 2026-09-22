type Extendable = Record<string, any>

const hasOwn = Object.prototype.hasOwnProperty
const toString = Object.prototype.toString
const defineProperty = Object.defineProperty
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function isPlainObject(value: unknown): value is Extendable {
  if (!value || toString.call(value) !== '[object Object]') return false

  const candidate = value as Extendable
  const hasOwnConstructor = hasOwn.call(candidate, 'constructor')
  const hasPrototypeIsPrototypeOf = Boolean(
    candidate.constructor
      && candidate.constructor.prototype
      && hasOwn.call(candidate.constructor.prototype, 'isPrototypeOf'),
  )

  if (candidate.constructor && !hasOwnConstructor && !hasPrototypeIsPrototypeOf) return false

  let key: string | undefined
  for (key in candidate) {
    // iterate to find last enumerable key
  }

  return key === undefined || hasOwn.call(candidate, key)
}

function getProperty(target: Extendable, key: string): any {
  if (key === '__proto__') {
    if (!hasOwn.call(target, key)) return undefined
    if (getOwnPropertyDescriptor) return getOwnPropertyDescriptor(target, key)?.value
  }

  return target[key]
}

function setProperty(target: Extendable, key: string, value: any): void {
  if (key === '__proto__' && defineProperty) {
    defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value,
    })
    return
  }

  target[key] = value
}

function extend(...args: any[]): any {
  let target = args[0]
  let index = 1
  let deep = false

  if (typeof target === 'boolean') {
    deep = target
    target = args[1] ?? {}
    index = 2
  }

  if (target == null || (typeof target !== 'object' && typeof target !== 'function')) {
    target = {}
  }

  for (; index < args.length; index += 1) {
    const source = args[index]
    if (source == null) continue

    for (const key in source) {
      const current = getProperty(target, key)
      const next = getProperty(source, key)
      if (target === next || typeof next === 'undefined') continue

      if (deep && (isPlainObject(next) || isArray(next))) {
        const clone = isArray(next)
          ? (isArray(current) ? current : [])
          : (isPlainObject(current) ? current : {})
        setProperty(target, key, extend(true, clone, next))
        continue
      }

      setProperty(target, key, next)
    }
  }

  return target
}

export default extend
