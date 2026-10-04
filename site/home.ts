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
<h1>Talk to your coding agents.<br><span class="dim">On every machine you own.</span></h1>
<p class="lede">Your laptop, a big VM, the box under your desk. Run Claude Code sessions on all of them, each piece of work in its own copy of your stack, and drive every one from a single page by talking to it.</p>
<div class="install">
<code>${INSTALL_LINE}</code>
<button type="button" class="btn quiet small" data-copy="${INSTALL_LINE}">Copy</button>
</div>
<p class="after">Then run <code>crew</code>. macOS and Linux · add any machine you can SSH into · your own Claude Code login</p>
</header>

<section class="wrap" aria-label="Voice OS" style="padding-top: 56px">
<img class="shot" src="/images/voice-os/hero.png" alt="Voice OS: a session on another machine with its work stream, dev servers and spoken summary, and the other active sessions as tabs">
<p class="caption"><span class="dot amber"></span>This session runs on Build box, a Linux VM. You are talking to it from a Mac.</p>
</section>

<section class="wrap machines" aria-label="Every machine">
<div class="text">
<span class="kicker">Every machine, one voice</span>
<h2>Your laptop is the cockpit. The work runs wherever it's fastest.</h2>
<p>Point crew at a machine you can SSH into and its sessions show up next to yours: same page, same voice, same alerts. The heavy builds, the dev servers and the Claude sessions stay over there. Only your words and their answers travel.</p>
</div>
<div class="diagram" role="img" aria-label="This Mac, the main, connected over SSH to Build box and Lab box, each running its own sessions">
<div class="mach you">
<span class="kicker">Main · in front of you</span>
<h4><span class="dot"></span>This Mac</h4>
<span class="host">voice, the page, your keys</span>
<div class="chip"><span class="dot amber"></span>store-front/main<small>running</small></div>
<div class="chip"><span class="dot grey"></span>checkout<small>idle</small></div>
</div>
<div class="link"><i></i>ssh<i></i></div>
<div class="mach">
<span class="kicker">Remote</span>
<h4><span class="dot"></span>Build box</h4>
<span class="host">dev@store-vm · Linux VM</span>
<div class="chip"><span class="dot amber"></span>store-front/wrk2<small>running</small></div>
<div class="chip"><span class="dot red"></span>signals/wrk1<small>asks you</small></div>
<div class="chip faint">web · api<small>dev servers up</small></div>
</div>
<div class="link"><i></i>ssh<i></i></div>
<div class="mach">
<span class="kicker">Remote</span>
<h4><span class="dot red"></span>Lab box</h4>
<span class="host">dev@lab-vm · out of reach</span>
<div class="chip"><span class="dot amber"></span>admin/wrk3<small>still working</small></div>
<span class="host">Its sessions keep going. Your words wait and are sent when it's back.</span>
</div>
</div>
<div class="facts-row">
<div class="fact"><b>Add it with its SSH host</b><p>Install crew there, run <code>crew server remote</code>, then add the host in Set up. No ports to open and nothing exposed. It rides the SSH you already use.</p></div>
<div class="fact"><b>Talk to any session by name</b><p>"Build box store front, run the migrations." Home lists every machine's sessions with whatever waits on you first, and alerts say where they come from.</p></div>
<div class="fact"><b>Links drop. Work doesn't.</b><p>Close the laptop, lose the Wi-Fi. Sessions over there keep working, and when the link is back you hear what finished meanwhile.</p></div>
<div class="fact"><b>One crew everywhere</b><p>Update the main and it brings its remotes along. Logs from every machine come back in one query, and any machine can post to your Discord.</p></div>
</div>
<a class="more" href="/guides/voice-os/#other-machines">How other machines work →</a>
</section>

<section class="wrap split" aria-label="What it sounds like" style="padding-top: 120px">
<div class="text">
<span class="kicker">What it sounds like</span>
<h2 class="big">You talk. The session on screen listens. The rest wait their turn.</h2>
<p>A small router in the middle decides where your words go, and it's strict about one thing: anything about the actual work goes to the session, in your words. It never answers for it or guesses what you meant.</p>
</div>
<div class="talk panel">
<p class="say you"><span class="who">you</span>build box store front, run the e2e suite</p>
<p class="say vo"><span class="who">voice os</span>Sent to store-front wrk2 on Build box. Switch there?</p>
<p class="say you"><span class="who">you</span>no, stay. what's waiting on me?</p>
<p class="say vo"><span class="who">voice os</span>Build box, signals asks: a new events table for clicks, or the orders table?</p>
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
<h3>Hand it what you see</h3>
<p>Paste a screenshot or drop a log on a session's page and it goes along with your next words, to a session on this machine or any other.</p>
</div>
</section>

<section class="wrap" aria-label="Home" style="padding-top: 80px">
<img class="shot" src="/images/voice-os/active.png" alt="Home: sessions on two machines, the one asking a question first, and a card for each machine">
<p class="caption">Home: every machine's sessions in one list, a card per machine, and Lab box out of reach without anything stopping.</p>
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
<p class="fineprint">MIT licensed</p>
</footer>
${COPY_SCRIPT}`;

  return page({
    title: 'crew · Voice OS',
    description:
      'Talk to your coding agents, on every machine you own. crew gives every piece of work its own copy of your stack, and Voice OS drives every Claude Code session, here or over SSH, by voice.',
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
