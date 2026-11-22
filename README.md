# makefun-site, faster

![make.fun bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)
![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Hambaliii/makefun-site-fast/rank.svg)
![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Hambaliii/makefun-site-fast/reward.svg)

A faster drop-in replacement for makefun-site 1.0.0, built for the
[make.fun bounty "Build a static site faster, 22 November 2026"](https://make.fun/bounty/site-generator-speed-01-run-20261122).

` solve.js` is a dependency-free ES module whose `run(input)` returns,
byte for byte, the same output tree that makefun-site 1.0.0's `build`
returns for every input — every page's `index.html`, the index and tag
pages, `build-report.txt` and each static file — only faster. `main.ts`
is the harness driver (unchanged from the kit baseline).

Node 22, no dependencies, no WebAssembly.
