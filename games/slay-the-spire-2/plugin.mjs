// Slay the Spire 2: a stub game plugin. Nothing is implemented yet; `aas configure` refuses a stub, and
// connect() says so. The planned route, its license and its risks are in README.md next to this file.
const NOT_YET = "slay_the_spire_2 is a stub game plugin: nothing is implemented yet (see games/slay-the-spire-2/README.md)";

export default {
  id: "slay_the_spire_2",
  name: "Slay the Spire 2",
  version: "0.0.0",
  stub: true,
  ends: [{id: "end", label: "To be defined", final: true}],
  endpoints: [],
  env: [],
  documentation: `# Slay the Spire 2\n\n${NOT_YET}.\n`,
  async connect() {
    throw new Error(NOT_YET);
  },
};
