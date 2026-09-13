// aas: a whole-run planner on top of gamerpuppy/sts_lightspeed. Plays a seed with the simulator's
// ScumSearchAgent2 (tree search in combat, policies outside it) and writes every decision as a JSON
// line the scripted bot can follow in the real game: map node, reward taken, card picked, rest
// option, event option, shop purchase, boss relic, and the battle lines with card names.
//   aas playout <seed> <ascension> <simulations> <agentRng> <out.jsonl>
//   aas room    <save.autosave> <simulations> [<agentRng>]
// "room" is the mode the bot uses against the real game. The fourteen RNG streams each carry a counter
// saying how far they have been drawn, and those counters live only in the game's own save, which the
// game writes when a room is entered. So the bot plans one room at a time from that save instead of
// playing a whole run computed up front: no assumption about the game's state can survive longer than
// a single room, and a difference in one room cannot drift into the next.
// Built against the sts_lightspeed sources (see build.sh next to this file).
#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include "game/Game.h"
#include "game/GameContext.h"
#include "game/Map.h"
#include "game/SaveFile.h"
#include "combat/BattleContext.h"
#include "sim/search/ScumSearchAgent2.h"
#include "sim/ConsoleSimulator.h"
#include <sstream>
#include "sim/search/GameAction.h"
#include "sim/search/Action.h"
#include "constants/Relics.h"
#include "constants/Potions.h"
#include "constants/Events.h"
#include "constants/MonsterEncounters.h"

using namespace sts;

static std::string jstr(const std::string &s) {
    // Every control character has to be escaped: the simulator's own labels carry tabs, and a raw one makes the
    // line unparseable JSON, which a reader then silently drops together with the decision it holds.
    static const char *hex = "0123456789abcdef";
    std::string o = "\"";
    for (unsigned char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            case '\b': o += "\\b"; break;
            case '\f': o += "\\f"; break;
            default:
                if (c < 0x20) { o += "\\u00"; o += hex[c >> 4]; o += hex[c & 0xf]; }
                else o += static_cast<char>(c);
        }
    }
    return o + "\"";
}
static std::string cardName(const Card &c) { return std::string(c.getName()) + (c.isUpgraded() ? "+" : ""); }

static std::string eventOptionLabel(const GameContext &gc, int option) {
    ConsoleSimulator sim;
    sim.gc = const_cast<GameContext *>(&gc);
    std::ostringstream os;
    sim.printEventActions(os);
    std::istringstream is(os.str());
    std::string line;
    const std::string prefix = std::to_string(option) + ":";
    while (std::getline(is, line)) {
        if (line.rfind(prefix, 0) != 0) continue;
        const auto open = line.find('['), close = line.find(']');
        if (open != std::string::npos && close != std::string::npos && close > open) return line.substr(open + 1, close - open - 1);
        return line.substr(prefix.size());
    }
    return "";
}

static std::string describe(const GameContext &gc, const search::GameAction &a) {
    std::ostringstream o;
    o << "{\"floor\":" << gc.floorNum << ",\"hp\":" << gc.curHp << ",\"gold\":" << gc.gold;
    if (a.isPotionAction()) {
        o << ",\"screen\":\"POTION\",\"kind\":" << (a.isPotionDiscard() ? "\"discard\"" : "\"drink\"") << ",\"idx\":" << a.getIdx1() << "}";
        return o.str();
    }
    switch (gc.screenState) {
        case ScreenState::EVENT_SCREEN: {
            // The simulator numbers an event's options straight through every phase (Golden Idol: 0,1 to take or
            // leave, then 2,3,4 to outrun, smash or hide), while the game starts at 0 again on the second screen.
            // An index is therefore not replayable; the label the simulator prints for that option is, so it goes
            // into the plan and the bot matches it against the choices the game shows.
            o << ",\"screen\":\"EVENT\",\"event\":" << jstr(eventGameNames[static_cast<int>(gc.curEvent)]) << ",\"option\":" << a.getIdx1();
            o << ",\"label\":" << jstr(eventOptionLabel(gc, a.getIdx1()));
            break;
        }
        case ScreenState::REWARDS: {
            const auto &r = gc.info.rewardsContainer;
            o << ",\"screen\":\"REWARDS\"";
            switch (a.getRewardsActionType()) {
                case search::GameAction::RewardsActionType::CARD: {
                    o << ",\"kind\":\"card\",\"reward\":" << a.getIdx1();
                    if (a.getIdx2() == 5) o << ",\"name\":\"singing bowl\"";
                    else o << ",\"name\":" << jstr(cardName(r.cardRewards[a.getIdx1()][a.getIdx2()]));
                    o << ",\"options\":[";
                    const auto &cr = r.cardRewards[a.getIdx1()];
                    for (int i = 0; i < cr.size(); ++i) o << (i ? "," : "") << jstr(cardName(cr[i]));
                    o << "]";
                    break;
                }
                case search::GameAction::RewardsActionType::GOLD: o << ",\"kind\":\"gold\",\"amount\":" << r.gold[a.getIdx1()]; break;
                case search::GameAction::RewardsActionType::KEY: o << ",\"kind\":\"key\""; break;
                case search::GameAction::RewardsActionType::POTION: o << ",\"kind\":\"potion\",\"name\":" << jstr(getPotionName(r.potions[a.getIdx1()])); break;
                case search::GameAction::RewardsActionType::RELIC: o << ",\"kind\":\"relic\",\"name\":" << jstr(getRelicName(r.relics[a.getIdx1()])); break;
                case search::GameAction::RewardsActionType::CARD_REMOVE: o << ",\"kind\":\"card_remove\""; break;
                case search::GameAction::RewardsActionType::SKIP: o << ",\"kind\":\"proceed\""; break;
            }
            break;
        }
        case ScreenState::BOSS_RELIC_REWARDS:
            o << ",\"screen\":\"BOSS_RELIC\",\"idx\":" << a.getIdx1() << ",\"name\":" << jstr(a.getIdx1() < 3 ? getRelicName(gc.info.bossRelics[a.getIdx1()]) : "skip") << ",\"options\":[";
            for (int i = 0; i < 3; ++i) o << (i ? "," : "") << jstr(getRelicName(gc.info.bossRelics[i]));
            o << "]";
            break;
        case ScreenState::CARD_SELECT: {
            const auto &cards = gc.info.toSelectCards;
            const int idx = a.getIdx1();
            int ordinal = 0;
            for (int i = 0; i < idx && i < cards.size(); ++i) if (cardName(cards[i].card) == cardName(cards[idx].card)) ++ordinal;
            o << ",\"screen\":\"CARD_SELECT\",\"type\":" << static_cast<int>(gc.info.selectScreenType) << ",\"idx\":" << idx << ",\"name\":" << jstr(idx < cards.size() ? cardName(cards[idx].card) : "?") << ",\"ordinal\":" << ordinal << ",\"count\":" << cards.size();
            break;
        }
        case ScreenState::MAP_SCREEN: {
            const int x = a.getIdx1(), y = gc.curMapNodeY + 1;
            o << ",\"screen\":\"MAP\",\"x\":" << x << ",\"y\":" << y;
            if (gc.map && y >= 0 && y < 15 && x >= 0 && x < 7) o << ",\"symbol\":" << jstr(std::string(1, gc.map->getNode(x, y).getRoomSymbol()));
            else o << ",\"symbol\":\"BOSS\"";
            break;
        }
        case ScreenState::TREASURE_ROOM: o << ",\"screen\":\"TREASURE\",\"kind\":" << (a.getIdx1() == 0 ? "\"open\"" : "\"skip\""); break;
        case ScreenState::REST_ROOM: {
            static const char *names[] = {"rest", "smith", "recall", "lift", "toke", "dig"};
            o << ",\"screen\":\"REST\",\"idx\":" << a.getIdx1() << ",\"name\":" << jstr(a.getIdx1() >= 0 && a.getIdx1() < 6 ? names[a.getIdx1()] : "?");
            break;
        }
        case ScreenState::SHOP_ROOM: {
            const auto &s = gc.info.shop;
            o << ",\"screen\":\"SHOP\"";
            switch (a.getRewardsActionType()) {
                case search::GameAction::RewardsActionType::CARD: o << ",\"kind\":\"card\",\"name\":" << jstr(cardName(s.cards[a.getIdx1()])) << ",\"price\":" << s.prices[a.getIdx1()]; break;
                case search::GameAction::RewardsActionType::POTION: o << ",\"kind\":\"potion\",\"name\":" << jstr(getPotionName(s.potions[a.getIdx1()])) << ",\"price\":" << s.prices[7 + a.getIdx1()]; break;
                case search::GameAction::RewardsActionType::RELIC: o << ",\"kind\":\"relic\",\"name\":" << jstr(getRelicName(s.relics[a.getIdx1()])) << ",\"price\":" << s.prices[10 + a.getIdx1()]; break;
                case search::GameAction::RewardsActionType::CARD_REMOVE: o << ",\"kind\":\"purge\",\"price\":" << s.removeCost; break;
                default: o << ",\"kind\":\"leave\""; break;
            }
            break;
        }
        default: o << ",\"screen\":\"?\"";
    }
    o << ",\"bits\":" << a.bits << "}";
    return o.str();
}

/** Plans the decisions of the room the save is in, and writes them as the same JSON lines as a playout. */
/** The event the game is showing, as the index of the simulator's own Event enum. The caller looks the name up
 *  in event-names.json, which is generated from this checkout, so no name matching is needed here. */
static Event eventFromArg(const char *arg) {
    if (arg == nullptr) return Event::INVALID;
    const int i = std::atoi(arg);
    return i > 0 ? static_cast<Event>(i) : Event::INVALID;
}

static int planRoom(int argc, const char *argv[]) {
    if (argc < 4) { std::cerr << "usage: aas room <save.autosave> <simulations> [agentRng] [eventEnumIndex]\n"; return 2; }
    const int sims = std::stoi(argv[3]);
    const std::uint64_t agentRng = argc > 4 ? std::stoull(argv[4]) : 0;
    const Event shownEvent = argc > 5 ? eventFromArg(argv[5]) : Event::INVALID;

    SaveFile saveFile = SaveFile::loadFromPath(argv[2], CharacterClass::IRONCLAD);
    GameContext gc;
    gc.initFromSave(saveFile, shownEvent);

    search::ScumSearchAgent2 agent;
    agent.simulationCountBase = sims;
    agent.rng = std::default_random_engine(agentRng);
    agent.printActions = false;
    std::streambuf *coutBuf = std::cout.rdbuf();
    std::ostringstream sink;
    std::cout.rdbuf(sink.rdbuf());

    std::ostringstream out;
    out << "{\"seed\":" << gc.seed << ",\"seedCode\":" << jstr(SeedHelper::getString(gc.seed))
        << ",\"floor\":" << gc.floorNum << ",\"hp\":" << gc.curHp << ",\"gold\":" << gc.gold
        << ",\"simulations\":" << sims << "}\n";
    search::g_gameActionHook = [&](const GameContext &g, const search::GameAction &a) { out << describe(g, a) << "\n"; };
    int battleFloor = -1; std::string encounter; int hpBefore = 0;
    search::g_battleActionHook = [&](const BattleContext &bc, const search::Action &a) {
        std::ostringstream d; a.printDesc(d, bc);
        out << "{\"floor\":" << battleFloor << ",\"screen\":\"BATTLE\",\"encounter\":" << jstr(encounter)
            << ",\"turn\":" << bc.turn << ",\"energy\":" << bc.player.energy << ",\"hp\":" << bc.player.curHp
            << ",\"desc\":" << jstr(d.str()) << "}\n";
    };

    // Everything this room still asks for: its fight when it has one, then the rewards, the event, the
    // campfire or the shop, and finally the map node that leaves the room. The floor number changing is
    // what ends the room; the next one is planned from the save the game writes on entering it.
    const int startFloor = gc.floorNum;
    while (gc.outcome == GameOutcome::UNDECIDED && gc.floorNum == startFloor) {
        if (gc.screenState == ScreenState::BATTLE) {
            BattleContext bc; bc.init(gc);
            battleFloor = gc.floorNum; encounter = monsterEncounterStrings[static_cast<int>(bc.encounter)]; hpBefore = gc.curHp;
            agent.playoutBattle(bc);
            out << "{\"floor\":" << battleFloor << ",\"screen\":\"BATTLE_END\",\"encounter\":" << jstr(encounter)
                << ",\"hpBefore\":" << hpBefore << ",\"hpAfter\":" << bc.player.curHp << "}\n";
            bc.exitBattle(gc);
            continue;
        }
        agent.stepOutOfCombatPolicy(gc);
    }
    std::cout.rdbuf(coutBuf);
    out << "{\"endOfRoom\":true,\"floor\":" << gc.floorNum << ",\"hp\":" << gc.curHp << ",\"gold\":" << gc.gold
        << ",\"outcome\":" << (gc.outcome == GameOutcome::UNDECIDED ? "\"undecided\"" :
                                 (gc.outcome == GameOutcome::PLAYER_VICTORY ? "\"victory\"" : "\"defeat\"")) << "}\n";
    std::cout << out.str();
    return 0;
}

/** Dumps the three acts of a seed's map as JSON, one line per node, so a route can be computed outside. */
static int dumpMap(int argc, const char *argv[]) {
    if (argc < 3) { std::cerr << "usage: aas map <seed> [ascension]\n"; return 2; }
    const std::uint64_t seed = std::stoull(argv[2]);
    const int ascension = argc > 3 ? std::stoi(argv[3]) : 0;
    for (int act = 1; act <= 3; ++act) {
        Map m = Map::fromSeed(seed, ascension, act, false);
        for (int y = 0; y < 15; ++y) {
            for (int x = 0; x < 7; ++x) {
                const MapNode &n = m.getNode(x, y);
                if (n.room == Room::NONE && n.edgeCount == 0 && n.parentCount == 0) continue;
                std::cout << "{\"act\":" << act << ",\"x\":" << x << ",\"y\":" << y
                          << ",\"symbol\":" << jstr(std::string(1, n.getRoomSymbol())) << ",\"edges\":[";
                for (int e = 0; e < n.edgeCount; ++e) std::cout << (e ? "," : "") << n.edges[e];
                std::cout << "]}\n";
            }
        }
    }
    return 0;
}

/** Prints the room the save is in exactly as the simulator sees it, so it can be held against the game's own
 *  screen. This is the conformance check: every field here is something the mod also reports, so a difference is
 *  a fact with a floor number instead of an opinion. */
static int describeRoom(int argc, const char *argv[]) {
    if (argc < 3) { std::cerr << "usage: aas describe <save.autosave> [eventEnumIndex]\n"; return 2; }
    SaveFile saveFile = SaveFile::loadFromPath(argv[2], CharacterClass::IRONCLAD);
    GameContext gc;
    gc.initFromSave(saveFile, argc > 3 ? eventFromArg(argv[3]) : Event::INVALID);

    std::ostringstream o;
    o << "{\"floor\":" << gc.floorNum << ",\"hp\":" << gc.curHp << ",\"maxHp\":" << gc.maxHp
      << ",\"gold\":" << gc.gold << ",\"room\":" << jstr(roomStrings[static_cast<int>(gc.curRoom)])
      << ",\"screen\":" << jstr(std::to_string(static_cast<int>(gc.screenState)));

    o << ",\"deck\":[";
    for (int i = 0; i < gc.deck.size(); ++i) o << (i ? "," : "") << jstr(cardName(gc.deck.cards[i]));
    o << "],\"relics\":[";
    for (int i = 0; i < gc.relics.size(); ++i) o << (i ? "," : "") << jstr(getRelicName(gc.relics.relics[i].id));
    o << "]";

    if (gc.curRoom == Room::EVENT) {
        o << ",\"event\":" << jstr(eventGameNames[static_cast<int>(gc.curEvent)]);
        ConsoleSimulator sim;
        sim.gc = &gc;
        std::ostringstream os;
        sim.printEventActions(os);
        o << ",\"eventOptions\":[";
        std::istringstream is(os.str());
        std::string line;
        bool first = true;
        while (std::getline(is, line)) { if (line.empty()) continue; o << (first ? "" : ",") << jstr(line); first = false; }
        o << "]";
    } else if (gc.curRoom == Room::SHOP) {
        const auto &sh = gc.info.shop;
        o << ",\"shopCards\":[";
        for (int i = 0; i < 7; ++i) o << (i ? "," : "") << "{\"name\":" << jstr(cardName(sh.cards[i])) << ",\"price\":" << sh.cardPrice(i) << "}";
        o << "],\"shopRelics\":[";
        for (int i = 0; i < 3; ++i) o << (i ? "," : "") << "{\"name\":" << jstr(getRelicName(sh.relics[i])) << ",\"price\":" << sh.relicPrice(i) << "}";
        o << "],\"shopPotions\":[";
        for (int i = 0; i < 3; ++i) o << (i ? "," : "") << "{\"name\":" << jstr(getPotionName(sh.potions[i])) << ",\"price\":" << sh.potionPrice(i) << "}";
        o << "],\"removeCost\":" << sh.removeCost;
    } else if (gc.curRoom == Room::TREASURE) {
        o << ",\"chest\":" << static_cast<int>(gc.info.chestSize);
    } else if (gc.curRoom == Room::BOSS_TREASURE) {
        o << ",\"bossRelics\":[";
        for (int i = 0; i < 3; ++i) o << (i ? "," : "") << jstr(getRelicName(gc.info.bossRelics[i]));
        o << "]";
    }
    o << "}";
    std::cout << o.str() << std::endl;
    return 0;
}

int main(int argc, const char *argv[]) {
    if (argc > 1 && std::string(argv[1]) == "room") return planRoom(argc, argv);
    if (argc > 1 && std::string(argv[1]) == "describe") return describeRoom(argc, argv);
    if (argc > 1 && std::string(argv[1]) == "map") return dumpMap(argc, argv);
    if (argc < 7 || std::string(argv[1]) != "playout") { std::cerr << "usage: aas playout <seed> <ascension> <simulations> <agentRng> <out.jsonl> [neowOption]\n           aas room <save.autosave> <simulations> [agentRng]\n"; return 2; }
    const int neowOption = argc > 7 ? std::stoi(argv[7]) : -1; // force Neow's choice (0..3); -1 = the agent decides
    const std::uint64_t seed = std::stoull(argv[2]);
    const int ascension = std::stoi(argv[3]);
    const int sims = std::stoi(argv[4]);
    const std::uint64_t agentRng = std::stoull(argv[5]);
    std::ofstream out(argv[6]);

    GameContext gc(CharacterClass::IRONCLAD, seed, ascension);
    search::ScumSearchAgent2 agent;
    agent.simulationCountBase = sims;
    agent.rng = std::default_random_engine(agentRng);
    agent.printActions = false;
    std::streambuf *coutBuf = std::cout.rdbuf();
    std::ostringstream sink;
    std::cout.rdbuf(sink.rdbuf());

    out << "{\"seed\":" << seed << ",\"seedCode\":" << jstr(SeedHelper::getString(seed)) << ",\"ascension\":" << ascension << ",\"simulations\":" << sims << "}\n";
    // Hooks: every decision is described with the state the agent saw before taking it.
    search::g_gameActionHook = [&](const GameContext &g, const search::GameAction &a) { out << describe(g, a) << "\n"; };
    int battleFloor = -1; std::string encounter; int hpBefore = 0;
    search::g_battleActionHook = [&](const BattleContext &bc, const search::Action &a) {
        std::ostringstream d; a.printDesc(d, bc);
        out << "{\"floor\":" << battleFloor << ",\"screen\":\"BATTLE\",\"encounter\":" << jstr(encounter) << ",\"turn\":" << bc.turn << ",\"energy\":" << bc.player.energy << ",\"hp\":" << bc.player.curHp << ",\"desc\":" << jstr(d.str()) << "}\n";
    };
    if (neowOption >= 0 && gc.screenState == ScreenState::EVENT_SCREEN) {
        search::GameAction a(neowOption);
        out << describe(gc, a) << "\n";
        a.execute(gc);
    }
    while (gc.outcome == GameOutcome::UNDECIDED) {
        if (gc.screenState == ScreenState::BATTLE) {
            BattleContext bc; bc.init(gc);
            battleFloor = gc.floorNum; encounter = monsterEncounterStrings[static_cast<int>(bc.encounter)]; hpBefore = gc.curHp;
            agent.playoutBattle(bc);
            out << "{\"floor\":" << battleFloor << ",\"screen\":\"BATTLE_END\",\"encounter\":" << jstr(encounter) << ",\"hpBefore\":" << hpBefore << ",\"hpAfter\":" << bc.player.curHp << "}\n";
            bc.exitBattle(gc);
            continue;
        }
        // No potions in this plan. A potion that generates a card (Liquid Memories, a Skill Potion's Discovery)
        // rolls a different card in the game than in the simulator (, measured:), and a plan that contains
        // one can never be replayed. Potion rewards are therefore dropped before the policy sees them, so the run
        // is played without potions at all and every step of it exists in the game as well.
        while (gc.screenState == ScreenState::REWARDS && gc.info.rewardsContainer.potionCount > 0) {
            gc.info.rewardsContainer.removePotionReward(0);
        }
        agent.stepOutOfCombatPolicy(gc);
    }
    std::cout.rdbuf(coutBuf);
    const bool won = gc.outcome == GameOutcome::PLAYER_VICTORY;
    out << "{\"outcome\":" << (won ? "\"victory\"" : "\"defeat\"") << ",\"floor\":" << gc.floorNum << ",\"hp\":" << gc.curHp << "}\n";
    std::cout << (won ? "victory" : "defeat") << " at floor " << gc.floorNum << " hp " << gc.curHp << std::endl;
    return won ? 0 : 1;
}
