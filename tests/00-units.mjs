const { validateSetting, EDITABLE_KEYS } = await import("./.build/src/lib/settings.js");
const fmt = await import("./.build/src/lib/format.js");

let fails = 0, passN = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passN++; }
  else { fails++; console.log(`  ✗ ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

console.log("--- validateSetting ---");
// Read-only keys must be rejected: owner_id is the trust root and must never
// be writable through the very UI it authorises.
check("owner_id rejected", validateSetting("owner_id","999").ok, false);
check("schema_version rejected", validateSetting("schema_version","2").ok, false);
check("unknown rejected", validateSetting("nope","x").ok, false);

check("relay_chat_id ok", validateSetting("relay_chat_id","-1001234567890"), {ok:true,value:"-1001234567890"});
check("relay_chat_id empty", validateSetting("relay_chat_id",""), {ok:true,value:""});
check("relay_chat_id spaces", validateSetting("relay_chat_id","  "), {ok:true,value:""});
check("relay_chat_id zero rejected", validateSetting("relay_chat_id","0").ok, false);
check("relay_chat_id junk rejected", validateSetting("relay_chat_id","abc").ok, false);
check("relay_chat_id float rejected", validateSetting("relay_chat_id","1.5").ok, false);
// 2^53 boundary: Telegram ids fit in 52 bits, anything beyond is not a real id.
check("relay_chat_id unsafe int rejected", validateSetting("relay_chat_id","9007199254740993").ok, false);

check("rate_limit_max ok", validateSetting("rate_limit_max","20"), {ok:true,value:"20"});
check("rate_limit_max 0 rejected", validateSetting("rate_limit_max","0").ok, false);
check("rate_limit_max neg rejected", validateSetting("rate_limit_max","-5").ok, false);
check("rate_limit_max huge rejected", validateSetting("rate_limit_max","999999").ok, false);

check("bool 1", validateSetting("sync_edits","1"), {ok:true,value:"1"});
check("bool true", validateSetting("sync_edits","true"), {ok:true,value:"1"});
check("bool 0", validateSetting("sync_edits","0"), {ok:true,value:"0"});
check("bool junk->0", validateSetting("sync_edits","maybe"), {ok:true,value:"0"});

check("forward_mode forward", validateSetting("forward_mode","forward"), {ok:true,value:"forward"});
check("forward_mode copy", validateSetting("forward_mode","copy"), {ok:true,value:"copy"});
check("forward_mode junk rejected", validateSetting("forward_mode","teleport").ok, false);

check("welcome_text ok", validateSetting("welcome_text","hi").ok, true);
check("welcome_text long rejected", validateSetting("welcome_text","x".repeat(3001)).ok, false);
check("welcome_text 3000 ok", validateSetting("welcome_text","x".repeat(3000)).ok, true);
console.log("  editable keys:", Object.keys(EDITABLE_KEYS).join(", "));

console.log("--- escapeHtml ---");
check("escape", fmt.escapeHtml('<b>&"x"</b>'), '&lt;b&gt;&amp;"x"&lt;/b&gt;');

console.log("--- displayName ---");
check("both", fmt.displayName({first_name:"Ada",last_name:"L"}), "Ada L");
check("first only", fmt.displayName({first_name:"Ada"}), "Ada");
check("null last", fmt.displayName({first_name:"Ada",last_name:null}), "Ada");
check("empty", fmt.displayName({first_name:"",last_name:""}), "(no name)");

console.log("--- topicName (Telegram caps at 128) ---");
check("with username", fmt.topicName({user_id:5,first_name:"Ada",username:"ada"}), "Ada @ada");
check("no username", fmt.topicName({user_id:5,first_name:"Ada"}), "Ada #5");
const long = fmt.topicName({user_id:5,first_name:"x".repeat(200),username:"y"});
check("truncated to 128", long.length, 128);
check("nameless falls back", fmt.topicName({user_id:7,first_name:"",last_name:""}), "(no name) #7");

console.log("--- parseUserIdArg ---");
check("plain", fmt.parseUserIdArg("12345"), 12345);
check("negative group", fmt.parseUserIdArg("-1001234567890"), -1001234567890);
check("padded", fmt.parseUserIdArg("  99  "), 99);
check("username rejected", fmt.parseUserIdArg("@alice"), null);
check("empty", fmt.parseUserIdArg(""), null);
check("undefined", fmt.parseUserIdArg(undefined), null);
check("zero rejected", fmt.parseUserIdArg("0"), null);
check("float rejected", fmt.parseUserIdArg("1.5"), null);
check("mixed rejected", fmt.parseUserIdArg("12abc"), null);

console.log("--- commandArgs ---");
check("with args", fmt.commandArgs("/ban 123 spamming"), "123 spamming");
check("no args", fmt.commandArgs("/ban"), "");
check("trailing space", fmt.commandArgs("/ban   "), "");
check("at-mention form", fmt.commandArgs("/ban@MyBot 123"), "123");

console.log("--- buildInfoCard ---");
const card = fmt.buildInfoCard({user_id:1001,first_name:"Ada",last_name:"L",username:"ada",language_code:"en",first_seen:1700000000,last_seen:1700000100,msg_count:3,rl_window_start:0,rl_window_count:0,blocked_bot:0}, false);
check("card has id", card.includes("<code>1001</code>"), true);
check("card has username", card.includes("@ada"), true);
check("card has profile link", card.includes("tg://user?id=1001"), true);
check("card not banned", card.includes("BANNED"), false);
const banned = fmt.buildInfoCard({user_id:1001,first_name:"Ada",last_name:"",username:null,language_code:null,first_seen:1,last_seen:2,msg_count:1,rl_window_start:0,rl_window_count:0,blocked_bot:1}, true);
check("banned card", banned.includes("BANNED"), true);
check("blocked-bot noted", banned.includes("blocked the bot"), true);
// HTML injection through a display name must be escaped, not rendered.
const evil = fmt.buildInfoCard({user_id:2,first_name:"<script>alert(1)</script>",last_name:"",username:'a"b',language_code:null,first_seen:1,last_seen:1,msg_count:0,rl_window_start:0,rl_window_count:0,blocked_bot:0}, false);
check("name escaped", evil.includes("&lt;script&gt;"), true);
check("no raw script tag", evil.includes("<script>"), false);

console.log(`\n${passN} passed, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
