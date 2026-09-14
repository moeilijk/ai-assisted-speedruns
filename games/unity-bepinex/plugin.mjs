// Unity games through BepInEx (generic bridge): a stub game plugin. Nothing is implemented yet; `aas configure` refuses a stub, and
// connect() says so. The planned route, its license and its risks are in README.md next to this file.
const NOT_YET = "unity_bepinex is a stub game plugin: nothing is implemented yet (see games/unity-bepinex/README.md)";

export default {
  id: "unity_bepinex",
  name: "Unity games through BepInEx (generic bridge)",
  version: "0.0.0",
  stub: true,
  ends: [{id: "end", label: "To be defined", final: true}],
  endpoints: [],
  env: [],
  documentation: `# Unity games through BepInEx (generic bridge)\n\n${NOT_YET}.\n`,
  async connect() {
    throw new Error(NOT_YET);
  },
};
