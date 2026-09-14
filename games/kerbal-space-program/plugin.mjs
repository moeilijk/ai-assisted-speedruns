// Kerbal Space Program: a stub game plugin. Nothing is implemented yet; `aas configure` refuses a stub, and
// connect() says so. The planned route, its license and its risks are in README.md next to this file.
const NOT_YET = "kerbal_space_program is a stub game plugin: nothing is implemented yet (see games/kerbal-space-program/README.md)";

export default {
  id: "kerbal_space_program",
  name: "Kerbal Space Program",
  version: "0.0.0",
  stub: true,
  ends: [{id: "mun_landing", label: "Mun Landing", final: true}],
  endpoints: [],
  env: [],
  documentation: `# Kerbal Space Program\n\n${NOT_YET}.\n`,
  async connect() {
    throw new Error(NOT_YET);
  },
};
