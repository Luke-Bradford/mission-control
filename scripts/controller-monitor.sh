#!/bin/zsh
# Controller monitor: prints one line per event that needs the controller or FLIGHT.
# The checks and their thresholds are in docs/runbooks/standing-checks.md.
MC_HUB=${MC_HUB:-localhost:7420}
MC_REPO=${MC_REPO:?set MC_REPO=owner/repo}
DATA=${MC_DATA:-$HOME/.local/share/mission-control}
T=$(cat $DATA/operator-token)
declare -A clean; declare -A told
SEEN=$DATA/controller/mon-told.txt
touch $SEEN
PRSEEN=$DATA/controller/mon-prs.txt; touch $PRSEEN
# start from 30 minutes back, so a restart does not skip a note FLIGHT wrote just before it
lastnote=$(curl -s -H "x-mc-operator: $T" $MC_HUB/api/flight | jq --argjson c $(( ($(date +%s) - 1800) * 1000 )) '[.decisions[]|select(.at < $c)|.id]|max // 0' 2>/dev/null || echo 0)
while true; do
  now=$(date +%s)
  tick=$(( ${tick:-0} + 1 ))
  (( tick % 5 == 1 )) && while read -r n ok; do
    [ -z "$n" ] && continue
    if [ "$ok" = "1" ]; then
      [ -z "${clean[$n]}" ] && clean[$n]=$now
      if [ $((now - clean[$n])) -ge 300 ] && ! grep -qx "$n" $SEEN; then echo "needs-merge: PR $n clean for 5+ min"; echo $n >> $SEEN; fi
    else unset "clean[$n]"; sed -i '' "/^$n\$/d" $SEEN; fi
  done < <(gh pr list --repo $MC_REPO --state open --json number,statusCheckRollup --jq '.[]|"\(.number) "+(if ([.statusCheckRollup[]|(.conclusion // .state)]|length)>0 and all([.statusCheckRollup[]|(.conclusion // .state)][]; .=="SUCCESS") then "1" else "0" end)' 2>/dev/null || true)
  T=$(cat $DATA/operator-token)
  # every builder seat (GUIDO/INCO, not stopped) idle for 10+ minutes: dead time
  busy=$(curl -s -m 10 -H "x-mc-operator: $T" $MC_HUB/api/crew 2>/dev/null | jq '[.rows[]|select(.kind=="crew" and (.role=="GUIDO" or .role=="INCO") and .hudState!="stopped" and .hudState!="idle")]|length' 2>/dev/null)
  if [ "$busy" = "0" ]; then
    [ -z "$idle_since" ] && idle_since=$now
    if [ $((now - idle_since)) -ge 600 ] && [ -z "$idle_told" ]; then echo "idle: every builder seat idle 10+ min"; idle_told=1; fi
  elif [ -n "$busy" ]; then idle_since=""; idle_told=""; fi
  j=$(curl -s -m 10 -H "x-mc-operator: $T" $MC_HUB/api/flight 2>/dev/null)
  echo "$j" | jq -r --argjson l "${lastnote:-0}" '.decisions[]|select(.id>$l and .kind=="note" and (.decision|test("controller";"i")))|"flight-note: \(.id) | \(.about)"' 2>/dev/null
  m=$(echo "$j" | jq '[.decisions[].id]|max' 2>/dev/null)
  [ -n "$m" ] && [ "$m" != "null" ] && lastnote=$m
  # a seat whose run was interrupted, crashed or stopped: 2 minutes; a reasoned crew pause with queued work: 30 minutes
curl -s -m 10 -H "x-mc-operator: $T" $MC_HUB/api/crew 2>/dev/null | jq -r --argjson now $((now*1000)) '.rows[]|select(.kind=="crew")|. as $r|(($now - (.stateSince // $now))) as $age
  | if ((.hudState=="stopped" or .hudState=="error" or ((.loop.text // "")|test("crashed|interrupted|run ended";"i"))) and .crewPause == null and $age > 120000) then "\(.id) \(.hudState) \(.loop.text // "" | .[0:60])"
    elif (.crewPause != null and ((.queue // [])|length) > 0 and $age > 1800000) then "\(.id) paused queue \([.queue[].issue]|join(","))"
    else empty end' 2>/dev/null | while read -r r; do k="down:${r%% *}:$(echo "$r" | cut -c1-40)"; grep -qxF "$k" $SEEN || { echo "seat-down: $r"; echo "$k" >> $SEEN; }; done
  # every open PR has an owner and is moving: no run, or parked 10+ minutes, is flagged (checked every 5 minutes)
if (( tick % 5 == 1 )); then
  crewj=$(curl -s -m 10 -H "x-mc-operator: $T" $MC_HUB/api/crew 2>/dev/null)
  gh api "repos/$MC_REPO/pulls?state=open&per_page=60" --jq '.[].number' 2>/dev/null | while read -r n; do
    st=$(echo "$crewj" | jq -r --argjson n $n '[.rows[]|(.asideRuns[]?, {loop:.loop})|select(.loop.prNumber==$n)|.loop.phase+"|"+(.loop.text // "")][0] // "none"' 2>/dev/null)
    case "$st" in none) key="pr:$n:none";; parked*) key="pr:$n:${st:0:60}";; *) sed -i '' "/^pr:$n:/d" $PRSEEN 2>/dev/null; continue;; esac
    first=$(grep -F "$key|" $PRSEEN 2>/dev/null | head -1 | cut -d'|' -f2); [ -z "$first" ] && { echo "$key|$now" >> $PRSEEN; continue; }
    if [ $((now - first)) -ge 600 ] && ! grep -qxF "told:$key" $SEEN; then echo "pr-stuck: PR $n ${st:0:100}"; echo "told:$key" >> $SEEN; fi
  done
fi
  # every 30 minutes: remote branches with no open PR (not main or archive/*) are orphans to delete (#1207)
if (( tick % 30 == 2 )); then
  open=$(gh api "repos/$MC_REPO/pulls?state=open&per_page=100" --jq '.[].head.ref' 2>/dev/null)
  gh api --paginate "repos/$MC_REPO/branches?per_page=100" --jq '.[].name' 2>/dev/null | grep -v -x -e main -e 'archive/.*' | while read -r b; do echo "$open" | grep -qxF "$b" || { grep -qxF "orphan:$b" $SEEN || { echo "branch-orphan: $b"; echo "orphan:$b" >> $SEEN; }; }; done
fi
  # runs waiting on the controller's own verdict (controller-check parks), active or set aside
curl -s -m 10 -H "x-mc-operator: $T" $MC_HUB/api/crew 2>/dev/null | jq -r '.rows[]|(.asideRuns[]?, {runId:.run.id, loop:.loop})|select((.loop.text // "")|test("controller check"))|"\(.runId) PR \(.loop.prNumber)"' 2>/dev/null | while read -r r; do grep -qx "cc:$r" $SEEN || { echo "controller-check: $r"; echo "cc:$r" >> $SEEN; }; done
  # FLIGHT's requests to the controller arrive as attention items (comms blockers), not notes
curl -s -m 10 -H "x-mc-operator: $T" $MC_HUB/api/attention 2>/dev/null | jq -r '(if type=="array" then . else .items end)[]? | select((.brief.for? == "flight") and ((.brief.assessment? // "") | test("controller";"i"))) | .key' 2>/dev/null | while read -r k; do grep -qx "ask:$k" $SEEN || { echo "controller-ask: $k"; echo "ask:$k" >> $SEEN; }; done
  sleep 60
done
