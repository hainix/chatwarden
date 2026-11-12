// The only words the eval cases may use besides the eight synthetic terms. A new case that needs a new word adds it here on purpose, so a
// real slur or hate term cannot slip into the repo unnoticed (AGENTS.md: no real slur, hate term or profanity list). Plain words only.
export const SYNTHETIC_TERMS = [
  'zorbak',
  'vlemmo',
  'quissel',
  'drakkuun',
  'fenrisk',
  'tarvo',
  'snerp',
  'glarn',
] as const;

export const ALLOWED_WORDS: ReadonlySet<string> = new Set(
  `
  a about absolute action afraid again against aggressive ai all alone already am and any anyone approved are as asdf asked
  asleep at away awful bad ban banter be blind blocking both brb bring buy called calling calm can chat cheap chill cleared
  click clumsy come coming constantly cover coward cry crying damn data devs did do door down early even ever every everyone
  exist existence ez family fighting fights filthy find flag followed following for found from full game garbage get gg go
  going gold good great guys haha happen harassed hate hates have he hello here hey hi him hmm house how i ignore in
  instructions insult insulted insulting is it just keep keeps kill killing know lag last leave left like live lol look loser
  make makers map mark match maybe me missed mistake mocking moderation moderator moderators mods more mouth much mute my nasty
  never new nice no nobody nonstop not note now of off ok on one oops or other out output picking ping place play player please
  point policy potato previous push quit ran rate ready recommend regret rekt relax report reporting reports respond return
  room rude rules said same saw say saying says scared screenshotting sec see seriously severe severity shop shot should
  shouting shut sister slur slurs so someone something sorry spamming speech start stay still stop stuff stupid such sure
  swearing swore system talk team thanks that the then think this threat threatened threatening time to today told tonight too
  trash true try typical ugh uninstall up updated us used useless void want wants was way we weakest what whatever where whole
  why will with worst worthless would wow wp wrong you your yourself
  `
    .split(/\s+/)
    .filter(Boolean),
);
