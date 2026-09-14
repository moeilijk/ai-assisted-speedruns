// Half-Life 2 / Episode One / Half-Life: Source: a stub game plugin. Nothing is implemented yet; `aas configure` refuses a stub, and
// connect() says so. The planned route, its license and its risks are in README.md next to this file.
const NOT_YET = "half_life_2 is a stub game plugin: nothing is implemented yet (see games/half-life-2/README.md)";

export default {
  id: "half_life_2",
  name: "Half-Life 2 / Episode One / Half-Life: Source",
  version: "0.0.0",
  stub: true,
  ends: [{id: "end", label: "To be defined", final: true}],
  endpoints: [],
  env: [],
  documentation: `# Half-Life 2 / Episode One / Half-Life: Source\n\n${NOT_YET}.\n`,
  async connect() {
    throw new Error(NOT_YET);
  },
};
