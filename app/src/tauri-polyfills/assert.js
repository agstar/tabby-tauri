function assert(value, message) {
  if (!value) throw new Error(message || 'Assertion failed')
}
assert.ok = assert
assert.equal = function equal(actual, expected, message) {
  // eslint-disable-next-line eqeqeq
  if (actual != expected) throw new Error(message || ('Expected ' + actual + ' to equal ' + expected))
}
assert.strictEqual = function strictEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message || ('Expected ' + actual + ' to strictly equal ' + expected))
}
module.exports = assert
