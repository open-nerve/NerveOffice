// Controlled diagnostic process only; no production use or external input.
const mode = process.argv[2]
if (mode === 'timeout') setInterval(() => {}, 1000)
else if (mode === 'crash') process.exit(17)
else if (mode === 'address-limit') {
  let refused = false
  try {
    // Reserve, do not touch, 2 GiB. RLIMIT_AS must reject it without using
    // physical RAM; the whole experiment also has a 512 MiB cgroup ceiling.
    const memory = Buffer.allocUnsafe(2 * 1024 * 1024 * 1024)
    console.log(JSON.stringify({ refused, allocated: memory.length }))
  }
  catch (error) {
    refused = true
    console.log(JSON.stringify({ refused, error: String(error) }))
  }
}
else throw new Error('Unknown controlled fault')
