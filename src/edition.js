// Which app this build is:
//   full — hosting, active nodes and the automatic event settings
//   lite — hosting and active nodes only (for other hosts in the cluster)
// build.js bakes BDO_EDITION=lite into the lite exe; `--lite` does the same in
// dev (npm run start:lite). Read at call time because baked values reach
// process.env only after startup has loaded them.
function edition(env = process.env, argv = process.argv) {
  return env.BDO_EDITION === 'lite' || argv.includes('--lite') ? 'lite' : 'full';
}

module.exports = { edition };
