import { INSTALL_LINE, page, REPO_URL } from './layout';

// Inline because it is the only script on the site and the install line is the page's main action.
const COPY_SCRIPT = `<script>
document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.getAttribute('data-copy'));
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select it';
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 1600);
  });
});
</script>`;

export function landingPage(): string {
  const body = `<header class="wrap hero">
<h1>Talk to your coding agents.</h1>
<p class="lede">Running a few Claudes at once is great until you become the bottleneck, clicking through terminals to see who's stuck. Voice OS turns that into a conversation, with every piece of work in its own copy of your stack.</p>
<div class="install">
<code>${INSTALL_LINE}</code>
<button type="button" class="btn quiet small" data-copy="${INSTALL_LINE}">Copy</button>
</div>
<p class="after">Then run <code>crew</code>. macOS and Linux · your own Claude Code login · two API keys for voice</p>
</header>

<section class="wrap" aria-label="Voice OS" style="padding-top: 56px">
<img class="shot" src="/images/voice-os/hero.png" alt="Voice OS: a session on another machine with its work stream, dev servers and spoken summary, and the other active sessions as tabs">
</section>

<section class="wrap split" aria-label="What it sounds like" style="padding-top: 120px">
<div class="text">
<span class="kicker">What it sounds like</span>
<h2 class="big">You talk. The session on screen listens. The rest wait their turn.</h2>
<p>A small router in the middle decides where your words go, and it's strict about one thing: anything about the actual work goes to the session, in your words. It never answers for it or guesses what you meant.</p>
</div>
<div class="talk panel">
<p class="say you"><span class="who">you</span>checkout, add a retry with backoff to the payment client</p>
<p class="say vo"><span class="who">voice os</span>Sent to checkout. Switch there?</p>
<p class="say you"><span class="who">you</span>no, stay. what's waiting on me?</p>
<p class="say vo"><span class="who">voice os</span>Signals asks: a new events table for clicks, or the orders table?</p>
<p class="say you"><span class="who">you</span>the new table</p>
<p class="say vo"><span class="who">voice os</span>Checkout is done. Retries back off from 200 ms to 3.2 s, all 41 payment tests pass.</p>
</div>
</section>

<section class="wrap cols" aria-label="What it does" style="padding-top: 120px">
<div class="col">
<h3>Every piece of work gets its own stack</h3>
<p>A worktree per feature with all its repos, dev servers on ports that stay put, and env vars that point the services at each other. crew checks it all starts before you touch it.</p>
</div>
<div class="col">
<h3>Answer without switching</h3>
<p>Permissions, plans and questions come to you out loud. Say "yes" or "the second one" and the session carries on, while the one on screen stays on screen.</p>
</div>
<div class="col">
<h3>All your machines, one voice</h3>
<p>A VM or a second computer runs its own sessions, and the page in front of you drives them over SSH. If the link drops, the work over there keeps going.</p>
</div>
</section>

<section class="wrap" aria-label="Home" style="padding-top: 80px">
<img class="shot" src="/images/voice-os/active.png" alt="Home: sessions on two machines, the one asking a question first, and a card for each machine">
</section>

<section class="wrap split reverse" aria-label="Set up" style="padding-top: 120px">
<div style="flex: 1 1 520px; min-width: 0">
<img class="shot" src="/images/setup/chat.png" alt="Set up with Claude adding a repo, each crew command it ran with a recorded line under it">
</div>
<div class="text" style="flex-basis: 320px">
<span class="kicker">Setting it up</span>
<h2>Or just ask the Claude that lives in Set up.</h2>
<p>"Add the store api and store app repos from ~/code, wire the app's API URL to the API, and make a workspace with both." It runs the commands, checks every server starts, and shows you each one.</p>
</div>
</section>

<section class="wrap split" aria-label="Away from the desk" style="padding-top: 120px; gap: 56px">
<div class="text">
<span class="kicker">Away from the desk</span>
<h2>Walk the dog, keep shipping.</h2>
<p>The page works on your phone, and Voice OS can join a private Discord voice channel so you talk to your sessions from anywhere. Sessions can post screenshots and summaries there when you ask.</p>
</div>
<div style="flex: 0 1 300px; min-width: 0">
<img class="shot" src="/images/voice-os/phone.png" alt="Voice OS on a phone">
</div>
</section>

<section class="wrap" aria-label="Costs and data" style="padding-top: 120px">
<div class="cols facts panel">
<div class="col">
<span class="kicker">What it costs</span>
<p>crew is free. Sessions run on your own Claude Code login. The router costs about a third of a cent per spoken turn on your Anthropic key, and Soniox bills speech by audio time.</p>
</div>
<div class="col">
<span class="kicker">Where your data goes</span>
<p>Your voice goes to Soniox to become text and speech. What you say goes to Anthropic for routing. Keys, notes and logs stay on your machine, and recordings are never kept.</p>
</div>
<div class="col">
<span class="kicker">Where it stands</span>
<p>Young and moving fast. I build crew with crew every day, and every change goes through thousands of tests before it merges. <a href="${REPO_URL}/issues">Tell me when it breaks.</a></p>
</div>
</div>
</section>

<footer class="wrap closing">
<h2>Give it five minutes.</h2>
<div class="row">
<a class="btn primary" href="/start/">Install crew</a>
<a class="btn quiet" href="${REPO_URL}">Star it on GitHub</a>
</div>
<p class="fineprint">FSL-1.1-MIT · every release becomes MIT two years after it ships</p>
</footer>
${COPY_SCRIPT}`;

  return page({
    title: 'crew · Voice OS',
    description:
      'Talk to your coding agents. crew gives every piece of work its own copy of your stack, and Voice OS lets you drive every Claude Code session by voice.',
    path: '/',
    section: 'home',
    body,
  });
}

export function startPage(): string {
  const body = `<header class="wrap page-head" style="max-width: 860px">
<span class="kicker">Get started</span>
<h1>From nothing to talking to your first session.</h1>
<p>About five minutes, most of it crew making the first copy of your repos while you watch.</p>
</header>

<section class="wrap" aria-label="Steps">
<div class="step">
<span class="num">1</span>
<div class="body">
<h2>Install crew</h2>
<p>One line on macOS or Linux. It puts <code>crew</code> in your path and nothing else. git and tmux are the only things it needs, and if one is missing <code>crew doctor --install</code> sorts it out.</p>
<code class="codeblock">${INSTALL_LINE}</code>
</div>
</div>
<div class="step">
<span class="num">2</span>
<div class="body">
<h2>Run it, and tick your repos</h2>
<p>Bare <code>crew</code> starts its server and opens the page. The first time, it finds the git repos you already have, you tick the ones you work on and group them into a workspace. Then it makes the first working copy of all of them, installs and starts the dev servers, and shows you each step.</p>
<code class="codeblock">crew</code>
<img class="shot" src="/images/setup/first-run.png" alt="The first run: crew lists the git checkouts it found, each ticked, with the commands it will run" style="margin-top: 8px">
</div>
</div>
<div class="step">
<span class="num">3</span>
<div class="body">
<h2>Give Voice OS its two keys</h2>
<p>An Anthropic key for the router and the short spoken summaries, and a Soniox key for speech in and out. Voice OS checks each one before saving it on your machine, readable only by you. The sessions themselves run on your own Claude Code login.</p>
</div>
</div>
<div class="step">
<span class="num">4</span>
<div class="body">
<h2>Hold Space and talk</h2>
<p>"Run the tests." "What's waiting on me?" "Checkout, add a retry." The session on screen gets your words, a named one gets them from anywhere, and anything that needs you comes to you out loud.</p>
<img class="shot" src="/images/voice-os/listening-modes.png" alt="The listening-mode menu: Push to talk, On demand, Hands-free, Dictation" style="margin-top: 8px">
</div>
</div>
</section>

<section class="wrap next" aria-label="Next">
<a class="tile" href="/guides/voice-os/"><span class="kicker">Next</span><b>The Voice OS guide</b><span>Everything from first run to other machines.</span></a>
<a class="tile" href="/guides/getting-set-up/"><span class="kicker">Or</span><b>Set it all up as commands</b><span>The same steps typed out, for scripts and agents.</span></a>
</section>`;

  return page({
    title: 'Get started · crew',
    description: 'Install crew, tick your repos, give Voice OS its two keys and start talking. About five minutes.',
    path: '/start/',
    section: 'start',
    body,
  });
}
