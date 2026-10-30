#!/bin/zsh
# Controller monitor: prints one line per event that needs the controller or FLIGHT.
# The checks and their thresholds are in docs/runbooks/standing-checks.md.
# It only reads: the hub's GET routes need no token, and `gh` reads as the signed-in account.
# Its only writes are its own state files under $MC_DATA/controller.
#
#   MC_REPO=owner/repo zsh scripts/controller-monitor.sh
#
# MC_HUB  the hub (default localhost:7420)
# MC_DATA the hub's data folder (default ~/.local/share/mission-control; a preview hub with
#         MC_DB elsewhere keeps its files beside that DB)
# MC_TICK seconds between passes (default 60)

MC_HUB=${MC_HUB:-localhost:7420}
MC_REPO=${MC_REPO:?set MC_REPO=owner/repo}
DATA=${MC_DATA:-$HOME/.local/share/mission-control}
TICK=${MC_TICK:-60}
STATE="$DATA/controller"
mkdir -p "$STATE" || { echo "monitor: cannot create $STATE"; exit 1; }
SEEN="$STATE/mon-told.txt"    # events already reported, keyed by event and instance
FIRST="$STATE/mon-first.txt"  # "<key><TAB><epoch seconds>": when a condition was first seen
LAST="$STATE/mon-lastnote"    # the newest FLIGHT decision id already read
touch "$SEEN" "$FIRST"

tab=$'\t'
# report once per key
say() { grep -qxF -- "$1" "$SEEN" || { print -r -- "$2"; print -r -- "$1" >> "$SEEN"; } }
# forget keys that start with a prefix, so the next occurrence is reported again
forget() { local f; for f in "$SEEN" "$FIRST"; do awk -v p="$1" 'index($0, p) != 1' "$f" > "$f.tmp"; mv "$f.tmp" "$f"; done; }
# seconds since a condition was first seen (records it now if new)
age() {
  local line; line=$(awk -v p="$1$tab" 'index($0, p) == 1' "$FIRST" | tail -1)
  if [[ -z $line ]]; then print -r -- "$1$tab$now" >> "$FIRST"; print 0; else print $(( now - ${line##*$tab} )); fi
}

blind_hub=""; blind_gh=""
# the newest FLIGHT note already read: seeded from 30 minutes back, once the hub answers
seed_last() {
  local v; v=$(curl -s -m 10 "$MC_HUB/api/flight" | jq -e --argjson c $(( ($(date +%s) - 1800) * 1000 )) '[.decisions[]|select(.at < $c)|.id]|max // 0' 2>/dev/null) && print -r -- "$v" > "$LAST"
}
[[ -s $LAST ]] || seed_last

tick=0
while true; do
  now=$(date +%s); tick=$(( tick + 1 ))

  # the hub, read once per pass
  crew=$(curl -s -m 10 "$MC_HUB/api/crew")
  if ! print -r -- "$crew" | jq -e '.rows' >/dev/null 2>&1; then
    [[ -z $blind_hub ]] && print "monitor-blind: the hub at $MC_HUB is not answering; checks paused"
    blind_hub=1; sleep $TICK; continue
  fi
  [[ -n $blind_hub ]] && print "monitor: the hub answers again"; blind_hub=""

  # every 5th pass: GitHub (PR checks and PR flow)
  if (( tick % 5 == 1 )); then
    prs=$(gh pr list --repo "$MC_REPO" --state open --limit 200 --json number,isDraft,headRefName,statusCheckRollup 2>/dev/null)
    if [[ -z $prs ]]; then
      [[ -z $blind_gh ]] && print "monitor-blind: gh cannot read $MC_REPO (signed out or rate-limited); PR checks paused"
      blind_gh=1
    else
      [[ -n $blind_gh ]] && print "monitor: gh reads again"; blind_gh=""
      # a PR whose checks all passed (including the hub's mc/review when it posts one), not a draft, for 5+ minutes
      print -r -- "$prs" | jq -r '.[]|select(.isDraft|not)|"\(.number) " + (if ([.statusCheckRollup[]|(.conclusion // .state)]|length)>0 and all([.statusCheckRollup[]|(.conclusion // .state)][]; .=="SUCCESS" or .=="SKIPPED" or .=="NEUTRAL") then "1" else "0" end)' |
      while read -r n ok; do
        if [[ $ok == 1 ]]; then (( $(age "green:$n") >= 300 )) && say "green:$n" "needs-merge: PR $n has passed its checks for 5+ min"
        else forget "green:$n"; fi
      done
      # every open crew PR (branch feature/<n>-… or fix/<n>-…) has a run that is moving: none, or parked
      # for 10+ minutes, is reported. A PR the controller or a person opened has no run by design.
      print -r -- "$prs" | jq -r '.[]|select(.headRefName|test("^(feature|fix)/[0-9]+-"))|.number' | while read -r n; do
        st=$(print -r -- "$crew" | jq -r --argjson n $n '[.rows[]|(.asideRuns[]?, {loop:.loop})|select(.loop.prNumber==$n)|.loop.phase+" "+((.loop.text // "")|gsub("\n";" "))][0] // "none"')
        case $st in
          none) key="stuck:$n:none" ;;
          parked*) key="stuck:$n:${${st#parked }:0:60}" ;;
          *) forget "stuck:$n:"; continue ;;
        esac
        (( $(age "$key") >= 600 )) && say "$key" "pr-stuck: PR $n ${st:0:120}"
      done
    fi
  fi

  # every developer seat idle for 10+ minutes while a developer seat has queued work
  busy=$(print -r -- "$crew" | jq '[.rows[]|select(.kind=="crew" and .mode=="writer" and .hudState!="stopped" and .hudState!="idle")]|length')
  queued=$(print -r -- "$crew" | jq '[.rows[]|select(.kind=="crew" and .mode=="writer")|(.queue // [])[]]|length')
  # reported once per idle stretch: the stretch's start is in the key
  if [[ $busy == 0 && $queued -gt 0 ]]; then
    (( $(age "idle-since") >= 600 )) && say "idle:$(awk -v p="idle-since$tab" 'index($0, p) == 1 {split($0, a, "\t"); print a[2]}' "$FIRST" | tail -1)" "idle: every developer seat idle 10+ min with $queued tickets queued"
  else forget "idle-since$tab"; fi

  # seats: a run that crashed, was interrupted or ended in error, for 2+ minutes;
  # a seat stopped or crew-paused for 30+ minutes while it has queued work.
  # The key carries stateSince, so a second failure is reported again.
  print -r -- "$crew" | jq -r --argjson now $(( now * 1000 )) '.rows[]|select(.kind=="crew")|(.stateSince // $now) as $since|(($now - $since)) as $age
    | if ((.hudState=="error" or ((.loop.text // "")|test("crashed|interrupted";"i"))) and $age > 120000) then "\(.id)\t\($since)\t\(.hudState) \((.loop.text // "")|gsub("\n";" ")|.[0:60])"
      elif ((.hudState=="stopped" or .crewPause != null) and ((.queue // [])|length) > 0 and $age > 1800000) then "\(.id)\t\($since)\t\(.hudState) with queue \([.queue[].issue]|join(","))"
      else empty end' | while IFS=$tab read -r id since what; do say "seat:$id:$since" "seat-down: $id $what"; done

  # runs waiting on the controller's own verdict, active or set aside
  print -r -- "$crew" | jq -r '.rows[]|(.asideRuns[]?, {runId:.run.id, loop:.loop})|select((.loop.text // "")|test("controller check"))|"\(.runId)\t\(.loop.prNumber)\t\((.loop.text // "")|gsub("\n";" ")|.[0:40])"' |
    while IFS=$tab read -r run pr text; do say "check:$run:$text" "controller-check: $run PR $pr"; done

  # FLIGHT's requests to the controller (attention items it keeps for itself that name the controller)
  curl -s -m 10 "$MC_HUB/api/attention" | jq -r '(if type=="array" then . else .items end)[]?|select(.key and .brief.for? == "flight" and ((.brief.assessment? // "")|test("controller";"i")))|.key' 2>/dev/null |
    while read -r k; do say "ask:$k" "controller-ask: $k"; done

  # FLIGHT notes for the controller since the last one read (kept in a file, so a restart repeats none)
  j=$(curl -s -m 10 "$MC_HUB/api/flight")
  [[ -s $LAST ]] || seed_last
  last=$(<"$LAST")
  # the last-read id moves only when the notes were read, so a bad batch is retried, never lost
  if notes=$(print -r -- "$j" | jq -r --argjson l "${last:-0}" '.decisions[]|select(.id>$l and .kind=="note" and ((.decision // "")|test("controller";"i")))|"flight-note: \(.id) | \(.about|tostring|gsub("\n";" "))"' 2>/dev/null); then
    [[ -n $notes ]] && print -r -- "$notes"
    m=$(print -r -- "$j" | jq '[.decisions[]?.id]|max' 2>/dev/null); [[ -n $m && $m != null ]] && print -r -- "$m" > "$LAST"
  fi

  # every 30th pass: remote branches with no open PR and no live run (not main, not archive/*)
  if (( tick % 30 == 2 )) && [[ -z $blind_gh ]]; then
    heads=$(gh api --paginate "repos/$MC_REPO/pulls?state=open&per_page=100" --jq '.[].head.ref' 2>/dev/null) && {
      live=$(print -r -- "$crew" | jq -r '.rows[]|.run.branch // empty')
      gh api --paginate "repos/$MC_REPO/branches?per_page=100" --jq '.[].name' 2>/dev/null | grep -v -x -e main -e 'archive/.*' |
        while read -r b; do
          print -r -- "$heads"$'\n'"$live" | grep -qxF -- "$b" || say "orphan:$b" "branch-orphan: $b"
        done
      # a deleted branch is forgotten, so one recreated later is reported again
      branches=$(gh api --paginate "repos/$MC_REPO/branches?per_page=100" --jq '.[].name' 2>/dev/null) &&
        grep '^orphan:' "$SEEN" | while read -r k; do print -r -- "$branches" | grep -qxF -- "${k#orphan:}" || forget "$k"; done
    }
  fi

  sleep $TICK
done
