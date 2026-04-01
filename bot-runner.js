// Sandboxed bot runner for 4-player chess
// Input: { code, state } or { batch: [{code, state}] }
// Bot code must define decideMove(state) returning {from:{r,c}, to:{r,c}}

var chunks = [];
process.stdin.on("data", function(chunk) { chunks.push(chunk); });
process.stdin.on("end", function() {
  var input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch (e) {
    process.stdout.write(JSON.stringify(null));
    return;
  }

  var _Function = Function;
  var _stdout = process.stdout;
  var _JSON = JSON;

  delete global.require;
  delete global.module;
  delete global.exports;
  delete global.__filename;
  delete global.__dirname;
  if (process.mainModule) delete process.mainModule;
  process.env = Object.create(null);
  process.chdir = undefined;
  process.kill = undefined;
  process.dlopen = undefined;
  process.binding = undefined;
  process._linkedBinding = undefined;
  process.moduleLoadList = undefined;
  try { delete global.Buffer; } catch(e) {}
  try { delete global.URL; } catch(e) {}
  try { delete global.URLSearchParams; } catch(e) {}
  try { delete global.TextDecoder; } catch(e) {}
  try { delete global.TextEncoder; } catch(e) {}

  var fnCache = {};
  function getBotFn(code) {
    if (fnCache[code]) return fnCache[code];
    var fn = new _Function("state", code + "\n;if (typeof decideMove === 'function') { return decideMove(state); } return null;");
    fnCache[code] = fn;
    return fn;
  }

  function runOne(code, state) {
    try {
      var fn = getBotFn(code);
      var move = fn(state);
      if (move && typeof move === "object" && move.from && move.to) return move;
      return null;
    } catch (e) {
      return null;
    }
  }

  if (input.batch) {
    var results = [];
    for (var i = 0; i < input.batch.length; i++) {
      results.push(runOne(input.batch[i].code, input.batch[i].state));
    }
    _stdout.write(_JSON.stringify(results));
  } else {
    var move = runOne(input.code, input.state);
    _stdout.write(_JSON.stringify(move));
  }
});
