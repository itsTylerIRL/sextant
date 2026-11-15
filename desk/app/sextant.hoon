::  sextant: urbit network explorer
::
::    serves a web ui at /apps/sextant and a read-only json api at
::    /apps/sextant/api/...  all data comes from local scries:
::
::      %azimuth  points, sponsors, escapes, keys (galaxy → star → planet)
::      %ames     peers + mesa chums, for connection status (qos)
::      %pals     targets / leeches / mutuals, if installed
::      %vitals   active connectivity checks, if landscape is installed
::
::    ames's view of a peer can't be trusted for "online": it marks any
::    idle peer %dead 30s after the last packet, and stamps last-contact
::    before any contact.  so we probe: a remote scry of the hash of
::    their %kids desk (+probe-path), which ships serve to anyone (%base
::    is private by default).  any answer, even an empty one, means
::    they're up.  unlike a poke, a scry can be cancelled: one that goes
::    unanswered for +patience is %yawned and nothing keeps retrying.
::    the kernel's own upgrade prober (ted/prob) uses the same trick.
::    each ship's last verdict is kept until the next probe finishes.
::
::    moons are not on azimuth, so we only know the moons our ship has
::    talked to (or our own, via jael).
::
/-  vitals, docket
/+  default-agent, dbug, server, gossip
|%
+$  versioned-state  $%(state-0 state-1 state-2 state-3 state-4 state-5)
+$  state-0  [%0 public=?]
::  tree: cached /api/tree body, rebuilt by a behn timer; not persisted
::  next: when that timer fires, so a reload can cancel it
::
+$  state-1  [%1 public=? next=(unit @da) tree=(unit octs)]
::  probes: when we last scried a ship, and when it last answered.
::  sent > got means the last probe is out, or was given up on.
::
+$  state-2
  $:  %2
      public=?
      next=(unit @da)
      tree=(unit octs)
      probes=(map ship probe-2)
  ==
+$  probe-2  [sent=@da got=@da]
::  ok: the verdict of the last probe that finished, kept while the next
::  one is out so a re-check never blanks a ship's status
::  dirty: probes changed since /api/tree was last cached
::
+$  state-3
  $:  %3
      public=?
      next=(unit @da)
      tree=(unit octs)
      probes=(map ship probe-3)
      dirty=?
  ==
+$  probe-3  [sent=@da got=@da ok=(unit ?)]
::  miss: probes in a row that went unanswered, for backing off
::
+$  state-4
  $:  %4
      public=?
      next=(unit @da)
      tree=(unit octs)
      probes=(map ship probe)
      dirty=?
  ==
+$  probe  [sent=@da got=@da ok=(unit ?) miss=@ud]
::  app hits, gossiped like %hits does: every install of an app (synced
::  from a publisher) is one anonymous hit, passed to mutual pals and on
::  to theirs (+hops).  .id is random per install, so relayed copies
::  count once and an uninstall can retract its own install.
::
::  share: whether we gossip our own installs
::  mine:  our installs we've announced, by [publisher desk]
::  hits:  every install we've heard of (ours included), by app
::
+$  state-5
  $:  %5
      public=?
      next=(unit @da)
      tree=(unit octs)
      probes=(map ship probe)
      dirty=?
      share=?
      mine=(map [ship desk] [at=@da id=@uv])
      hits=(map [ship desk] app-hits)
  ==
+$  app-card  [title=@t info=@t color=@ux image=@t version=@t]
+$  app-hits  [card=app-card ids=(map @uv [at=@da on=?])]
+$  hit       [id=@uv app=[=ship =desk] at=@da on=? card=app-card]
++  hops      2
++  gossip-config  |=(on=? `config:gossip`[?:(on hops 0) %mutuals %mutuals |])
::  mirror of $pike (sur/hood.hoon on %base)
+$  pike
  $:  sync=(unit [=ship =desk])
      hash=@uv
      zest=?(%live %dead %held)
      wic=(set [lal=@tas num=@ud])
  ==
::
++  patience  ~s20  ::  probe unanswered this long: offline
++  recheck   ~m5   ::  don't re-probe a ship that answered this recently
++  max-out   50    ::  probes in flight at once; the rest wait their turn
::  +backoff: how long to leave a ship that has missed .miss probes in a
::  row.  most silent ships are abandoned and stay that way.
::
++  backoff
  |=  miss=@ud
  ^-  @dr
  ?:  (lte miss 1)  ~m15
  ?:  =(2 miss)  ~h1
  ?:  =(3 miss)  ~h6
  ~d1
::  +probe-path: the hash of their %kids desk as of a minute before .at.
::  %kids is public on every ship (%base isn't), and dating the case
::  makes each probe a new request: a cancelled request leaves an inert
::  entry in ames that a repeat of the same path would just join.
::
++  probe-path
  |=  at=@da
  ^-  path
  /c/z/(scot %da (sub at (add ~m1 (mod at ~s1))))/kids
+$  card  card:agent:gall
::  mirror of point:naive, so we don't need to vendor lib/naive
::
+$  address  @ux
+$  point
  $:  dominion=?(%l1 %l2 %spawn)
      $=  own
      $:  owner=[=address nonce=@]
          spawn-proxy=[=address nonce=@]
          management-proxy=[=address nonce=@]
          voting-proxy=[=address nonce=@]
          transfer-proxy=[=address nonce=@]
      ==
      $=  net
      $:  rift=@ud
          keys=[=life suite=@ud auth=@ crypt=@]
          sponsor=[has=? who=@p]
          escape=(unit @p)
  ==  ==
+$  points    (tree [ship point])
+$  naive-state  [%0 =points operators=* dns=(list @t)]
+$  sponsors  (map ship [residents=(set ship) requests=(set ship)])
+$  known     (map ship ?(%alien %known))
+$  qos       [kind=?(%live %dead %unborn %stale) last=@da]
::  mirrors of %pals types (sur/pals.hoon on the %pals desk)
+$  pal-command
  $%  [%meet =ship in=(set @ta)]
      [%part =ship in=(set @ta)]
  ==
+$  pal-records
  $:  outgoing=(jug ship @ta)
      incoming=(set ship)
      receipts=(map ship ?)
  ==
::  mirrors of %treaty types (sur/treaty.hoon on %landscape)
+$  treaty  [=ship =desk =case hash=@uv =docket:docket]
+$  treaty-update
  $%  [%ini init=(map [=ship =desk] =treaty)]
      [%add =treaty]
      [%del =ship =desk]
  ==
+$  ally-diff  $%([%add =ship] [%del =ship])
+$  ally-update
  $%  ally-diff
      [%ini init=(map ship (set [=ship =desk]))]
      [%new =ship alliance=(set [=ship =desk])]
  ==
::  per-request context, scried once
::
+$  ctx
  $:  chums=known
      peers=known
      pals=(unit [targets=(set ship) leeches=(set ship)])
  ==
--
::
%-  %+  agent:gossip  (gossip-config &)
    %-  ~(gas by *(map mark $-(* vase)))
    :~  [%sextant-hit |=(n=* !>(((soft hit) n)))]
    ==
%-  agent:dbug
=|  state-5
=*  state  -
^-  agent:gall
=<
|_  =bowl:gall
+*  this  .
    def   ~(. (default-agent this %|) bowl)
    hc    ~(. +> bowl)
::
++  on-init
  ^-  (quip card _this)
  :_  this(public |, next `now.bowl)
  :~  [%pass /eyre/connect %arvo %e %connect [~ /apps/sextant] dap.bowl]
      [%pass /tree %arvo %b %wait now.bowl]
  ==
::
++  on-save  !>(state(tree ~))
++  on-load
  |=  old-vase=vase
  ^-  (quip card _this)
  =/  old  !<(versioned-state old-vase)
  =/  new=state-5
    ?:  ?=(%5 -.old)  old(tree ~)
    =;  n=state-4  [%5 public.n next.n tree.n probes.n dirty.n & ~ ~]
    ?-  -.old
      %0  [%4 public.old ~ ~ ~ |]
      %1  [%4 public.old next.old ~ ~ |]
      %2  :*  %4  public.old  next.old  ~
              (~(run by probes.old) |=(p=probe-2 (probe-3-to-4:hc (probe-2-to-3:hc p))))
              |
          ==
      %3  [%4 public.old next.old ~ (~(run by probes.old) probe-3-to-4:hc) |]
      %4  old(tree ~)
    ==
  ::  replace any pending timer with one that rebuilds the cache now
  ::
  :_  this(state new(next `now.bowl))
  %+  weld
    ^-  (list card)
    ?~(next.new ~ [%pass /tree %arvo %b %rest u.next.new]~)
  ^-  (list card)
  [%pass /tree %arvo %b %wait now.bowl]~
::
++  on-poke
  |=  [=mark =vase]
  ^-  (quip card _this)
  ?+    mark  (on-poke:def mark vase)
  ::  :sextant [%public &]  →  let anyone browse (read-only)
  ::
      %noun
    ?>  =(our src):bowl
    =+  !<(cmd=[%public p=?] vase)
    ~&  [dap.bowl %public p.cmd]
    `this(public p.cmd)
  ::
      %handle-http-request
    =+  !<([eyre-id=@ta req=inbound-request:eyre] vase)
    =/  site  site:(parse-request-line:server url.request.req)
    ::  POST /api/share/on, /api/share/off: gossip our installs, or not
    ::
    ?:  ?&  ?=([%apps %sextant %api %share ?(%on %off) ~] site)
            ?=(%'POST' method.request.req)
            authenticated.req
        ==
      =/  on=?  =('on' i.t.t.t.t.site)
      :_  this(share on)
      %+  weld
        ^-  (list card)
        :-  (configure:gossip (gossip-config on))
        ::  turning it on: say what we have
        ?.  on  ~
        %+  turn  ~(tap by mine)
        |=  [k=[ship desk] at=@da id=@uv]
        (invent:gossip %sextant-hit !>(`hit`[id k at & card:(~(gut by hits) k *app-hits)]))
      (give-simple-payload:app:server eyre-id [[204 ~] ~])
    ::  POST /api/trace/~sampel: probe every hop between us and them now,
    ::  past the usual limits (a handful of ships, asked for by the owner)
    ::
    ?:  ?&  ?=([%apps %sextant %api %trace @ ~] site)
            ?=(%'POST' method.request.req)
            authenticated.req
        ==
      =/  who  (slaw %p i.t.t.t.t.site)
      ?~  who
        :_  this
        (give-simple-payload:app:server eyre-id [[400 ~] ~])
      =^  cards  probes  (probe-ships:hc (turn (route:hc u.who) head) &)
      :_  this
      %+  weld  cards
      %+  give-simple-payload:app:server  eyre-id
      (json-response:gen:server (trace-json:hc u.who))
    ::  POST /api/status ["~zod", ...]: status for a batch of ships.
    ::  for the owner it also probes the ones we haven't heard from lately
    ::
    ?:  ?&  =(~['apps' 'sextant' 'api' 'status'] site)
            ?=(%'POST' method.request.req)
            |(authenticated.req public)
        ==
      =/  who=(list ship)  (parse-ships:hc body.request.req)
      =^  cards  probes
        ?.  authenticated.req  [~ probes]
        (send-probes:hc who)
      :_  this
      %+  weld  cards
      %+  give-simple-payload:app:server  eyre-id
      (json-response:gen:server (statuses:hc who authenticated.req))
    ::  /api/tree is expensive: serve the cached body when we have one
    ::
    ?:  ?&  ?=(^ tree)
            |(authenticated.req public)
            =(~['apps' 'sextant' 'api' 'tree'] site)
        ==
      :_  this
      %+  give-simple-payload:app:server  eyre-id
      [[200 ~[['content-type' 'application/json'] ['cache-control' 'no-cache']]] tree]
    [(handle-http:hc eyre-id req) this]
  ==
::
++  on-watch
  |=  =path
  ^-  (quip card _this)
  ?:  ?=([%http-response @ ~] path)  `this
  ::  a pal subscribed through gossip: tell them our own installs
  ::
  ?:  =(/~/gossip/source path)
    :_  this
    ?.  share  ~
    %+  turn  ~(tap by mine)
    |=  [k=[ship desk] at=@da id=@uv]
    =/  c  card:(~(gut by hits) k *app-hits)
    [%give %fact ~ %sextant-hit !>(`hit`[id k at & c])]
  (on-watch:def path)
::
++  on-arvo
  |=  [=wire =sign-arvo]
  ^-  (quip card _this)
  ?:  ?=([%tree ~] wire)
    ?>  ?=([%behn %wake *] sign-arvo)
    =/  nex  (add now.bowl ~m1)
    ::  keep our pals and the galaxies fresh without being asked
    ::  (+want-probe limits how often each one is actually asked)
    ::
    =^  cards  probes  (send-probes:hc auto-targets:hc)
    ::  announce apps we've installed or removed since last time
    ::
    =^  hit-cards  state  (sync-installs:hc state)
    =.  cards  (weld cards hit-cards)
    :-  [[%pass /tree %arvo %b %wait nex] cards]
    ?.  |(dirty ?=(~ tree))  this(next `nex)
    this(next `nex, tree `tree-octs:hc, dirty |)
  ::  a probe answered
  ::
  ?:  ?=([%probe @ *] wire)
    =/  who  (slaw %p i.t.wire)
    ?.  &(?=(^ who) ?=([%ames %sage *] sign-arvo))  `this
    =/  p=probe  (~(gut by probes) u.who [now.bowl *@da ~ 0])
    `this(probes (~(put by probes) u.who p(got now.bowl, ok `&, miss 0)), dirty &)
  ::  a probe's time is up: cancel it if it's still out
  ::
  ?:  ?=([%yawn @ @ ~] wire)
    =/  who  (slaw %p i.t.wire)
    =/  at   (slaw %da i.t.t.wire)
    ?.  &(?=(^ who) ?=(^ at))  `this
    =/  p  (~(get by probes) u.who)
    ?.  &(?=(^ p) =(sent.u.p u.at) (lth got.u.p sent.u.p))  `this
    :_  this(probes (~(put by probes) u.who u.p(ok `|, miss +(miss.u.p))), dirty &)
    [%pass /probe/(scot %p u.who)/(scot %da u.at) %arvo %a %yawn u.who (probe-path u.at)]~
  ?.  ?=([%eyre %connect ~] wire)  (on-arvo:def wire sign-arvo)
  ?>  ?=([%eyre %bound *] sign-arvo)
  ~?  !accepted.sign-arvo  [dap.bowl %eyre-bind-failed binding.sign-arvo]
  `this
::
++  on-agent
  |=  [=wire =sign:agent:gall]
  ^-  (quip card _this)
  ::  a hit from a pal (or a pal's pal), via gossip
  ::
  ?:  =(/~/gossip/gossip wire)
    ?.  ?=(%fact -.sign)  `this
    ?.  =(%sextant-hit p.cage.sign)  `this
    =/  h  !<((unit hit) q.cage.sign)
    ?~  h  `this
    `this(hits (add-hit:hc hits u.h))
  ?:  ?=([%probe @ ~] wire)
    ::  acks for %ping pokes sent by an earlier version
    ::
    =/  who  (slaw %p i.t.wire)
    ?.  &(?=(^ who) ?=(%poke-ack -.sign))  `this
    =/  p=probe  (~(gut by probes) u.who [now.bowl *@da ~ 0])
    `this(probes (~(put by probes) u.who p(got now.bowl, ok `&, miss 0)), dirty &)
  ?.  ?=([?(%ping %pal %ally %install %hi) *] wire)  (on-agent:def wire sign)
  ?.  ?=(%poke-ack -.sign)  `this
  ~?  ?=(^ p.sign)  [dap.bowl %poke-failed wire]
  `this
::
++  on-peek   on-peek:def
++  on-leave  on-leave:def
++  on-fail   on-fail:def
--
::
::  helper core
::
|_  =bowl:gall
::  +bp: scry path /our/[desk-or-agent]/now/...
::
++  bp
  |=  [d=@tas p=path]
  ^-  path
  [(scot %p our.bowl) d (scot %da now.bowl) p]
::
++  respond
  |=  [type=@t =octs]
  ^-  simple-payload:http
  [[200 ['content-type' type]~] `octs]
::
::  +handle-http: route a request
::
++  handle-http
  |=  [eyre-id=@ta req=inbound-request:eyre]
  ^-  (list card)
  =/  give  (cury give-simple-payload:app:server eyre-id)
  =/  rl    (parse-request-line:server url.request.req)
  =/  site=(list @t)
    ?.  ?=([%apps %sextant *] site.rl)  ~
    t.t.site.rl
  =/  authed=?  authenticated.req
  =/  get=?     ?=(%'GET' method.request.req)
  ?.  |(authed public)
    ?:  ?=([%api *] site)
      (give [[403 ~] `(as-octs:mimes:html '{"error":"login required"}')])
    (give (login-redirect:gen:server request.req))
  ?+    site  (give not-found:gen:server)
      ~
    (give (respond 'text/html' (file /web/index/html)))
  ::
      [%app ~]
    (give (respond 'text/javascript' (file /web/app/js)))
  ::
      [%style ~]
    (give (respond 'text/css' (file /web/style/css)))
  ::
      [%sigil ~]
    (give (respond 'text/javascript' (file /web/sigil/js)))
  ::
      [%icon ~]
    (give (respond 'image/png' (file /web/icon/png)))
  ::
      [%api *]
    ?:  ?=([%ping @ ~] t.site)
      =/  who  (slaw %p i.t.t.site)
      ?~  who  (give [[400 ~] ~])
      ?.  get
        ::  starting a check sends network traffic; owner only
        ::
        ?.  authed  (give [[403 ~] ~])
        ?.  (running %vitals)  (give (json-response:gen:server (ping-json u.who)))
        :-  :*  %pass  /ping/(scot %p u.who)  %agent  [our.bowl %vitals]
                %poke  %run-check  !>(u.who)
            ==
        (give (json-response:gen:server (ping-json u.who)))
      (give (json-response:gen:server (ping-json u.who)))
    ?:  ?=([%hi @ ~] t.site)
      ::  say hi, like |hi: one message, which also introduces a comet
      ::  to a ship that has never heard of it (owner only, POST)
      ::
      =/  who  (slaw %p i.t.t.site)
      ?~  who  (give [[400 ~] ~])
      ?.  authed  (give [[403 ~] ~])
      ?:  get  (give [[405 ~] ~])
      :-  :*  %pass  /hi/(scot %p u.who)  %agent  [our.bowl %hood]
              %poke  %helm-send-hi  !>([u.who ~])
          ==
      (give [[204 ~] ~])
    ?:  ?=([%pal @ ~] t.site)
      ::  add (POST) or remove (DELETE) a pal; owner only
      ::
      =/  who  (slaw %p i.t.t.site)
      ?~  who  (give [[400 ~] ~])
      ?.  authed  (give [[403 ~] ~])
      ?.  (running %pals)  (give [[409 ~] ~])
      =/  del=?  ?=(%'DELETE' method.request.req)
      ?.  |(del ?=(%'POST' method.request.req))  (give [[405 ~] ~])
      =/  cmd=pal-command  ?:(del [%part u.who ~] [%meet u.who ~])
      :-  :*  %pass  /pal/(scot %p u.who)  %agent  [our.bowl %pals]
              %poke  %pals-command  !>(cmd)
          ==
      (give [[204 ~] ~])
    ?:  &(?=([%apps @ ~] t.site) !get)
      ::  look up the apps a ship publishes, via %treaty (owner only)
      ::
      =/  who  (slaw %p i.t.t.site)
      ?~  who  (give [[400 ~] ~])
      ?.  authed  (give [[403 ~] ~])
      ?.  (running %treaty)  (give [[409 ~] ~])
      :-  :*  %pass  /ally/(scot %p u.who)  %agent  [our.bowl %treaty]
              %poke  %ally-update-0  !>(`ally-diff`[%add u.who])
          ==
      (give [[204 ~] ~])
    ?:  ?=([%install @ @ ~] t.site)
      ::  install a desk a ship publishes (owner only, POST)
      ::
      =/  who  (slaw %p i.t.t.site)
      =*  d  i.t.t.t.site
      ?.  &(?=(^ who) ((sane %tas) d))  (give [[400 ~] ~])
      ?.  authed  (give [[403 ~] ~])
      ?:  get  (give [[405 ~] ~])
      :-  :*  %pass  /install/(scot %p u.who)/[d]  %agent  [our.bowl %hood]
              %poke  %kiln-install  !>([`desk`d `ship`u.who `desk`d])
          ==
      (give [[204 ~] ~])
    ?.  get  (give [[405 ~] ~])
    =/  res=(unit json)  (api t.site)
    ?~  res  (give not-found:gen:server)
    (give (json-response:gen:server u.res))
  ==
::
++  tree-octs
  ^-  octs
  (as-octs:mimes:html (en:json:html (need (api ~['tree']))))
::
++  file
  |=  =path
  ^-  octs
  (as-octs:mimes:html .^(@t %cx (bp q.byk.bowl path)))
::
++  running
  |=  dap=term
  ^-  ?
  .^(? %gu (bp dap /$))
::
::  +api: json endpoints
::
++  api
  |=  site=(list @t)
  ^-  (unit json)
  =,  enjs:format
  =/  =ctx  get-ctx
  ?+    site  ~
  ::  /api/me: who's hosting, what's available
  ::
      [%me ~]
    :-  ~
    %-  pairs
    :~  ship+s+(scot %p our.bowl)
        public+b+public
        pals+b+(running %pals)
        vitals+b+(running %vitals)
        points+(numb ~(wyt by points:nas))
    ==
  ::  /api/ship/~sampel: one ship in detail
  ::
      [%ship @ ~]
    =/  who  (slaw %p i.t.site)
    ?~  who  ~
    `(detail-json u.who ctx)
  ::  /api/residents/~sampel: ships sponsored by this one
  ::
      [%residents @ ~]
    =/  who  (slaw %p i.t.site)
    ?~  who  ~
    =/  pos  points:nas
    =/  rez  (~(gut by spo) u.who [residents=~ requests=~])
    :-  ~
    %-  pairs
    :~  :-  %residents
        :-  %a
        %+  turn  (sort ~(tap in residents.rez) lth)
        |=(k=@p (ship-json k (get-point pos k) ctx))
      ::
        :-  %requests
        :-  %a
        %+  turn  (sort ~(tap in requests.rez) lth)
        |=(k=@p (ship-json k (get-point pos k) ctx))
    ==
  ::  /api/tree: the live sponsorship tree from galaxies down to stars,
  ::  compact.  g: one row per galaxy, [name st life rel stars planets]
  ::  where stars/planets count the ships it currently sponsors.
  ::  s: every sponsored star, [name galaxy idx st life rel planets],
  ::  grouped by sponsoring galaxy and sorted by star number.
  ::  st: 0 never contacted, 1 live, 2 dead, 3 pending, 4 stale.
  ::  life: -1 not on azimuth.  rel: 1 we added them, 2 they added us.
  ::
      [%tree ~]
    =/  pos  points:nas
    =/  sp   spo
    =/  gal=(list @p)  (turn (gulf 0 255) |=(a=@ `@p`a))
    =|  gals=(list json)
    =|  stars=(list json)
    |-
    ?~  gal
      `(pairs ~[g+a+(flop gals) s+a+(flop stars)])
    =/  g=@p  i.gal
    =/  ks=(list @p)
      (sort ~(tap in residents:(~(gut by sp) g [residents=~ requests=~])) lth)
    =/  ss=(list @p)  (skim ks |=(k=@p ?=(%king (clan:title k))))
    =/  np=@ud  (lent (skim ks |=(k=@p ?=(%duke (clan:title k)))))
    =/  rows=(list json)
      %+  turn  ss
      |=  k=@p
      =/  n=@ud  ~(wyt in residents:(~(gut by sp) k [residents=~ requests=~]))
      (tiny k pos ctx `[`@ud`g n] 0 0)
    %=  $
      gal    t.gal
      gals   [(tiny g pos ctx ~ (lent ss) np) gals]
      stars  (weld (flop rows) stars)
    ==
  ::  /api/trace/~sampel: the hops between us and them, with how each
  ::  answered (see +trace-json)
  ::
      [%trace @ ~]
    =/  who  (slaw %p i.t.site)
    ?~  who  ~
    `(trace-json u.who)
  ::  /api/catalog: every published app our ship knows of
  ::
      [%catalog ~]
    `catalog-json
  ::  /api/apps/~sampel: what this ship publishes, as %treaty knows it
  ::
      [%apps @ ~]
    =/  who  (slaw %p i.t.site)
    ?~  who  ~
    `(apps-json u.who)
  ::  /api/pals: our pals graph, with status
  ::
      [%pals ~]
    ?~  pals.ctx  `~
    =/  pos  points:nas
    =/  all  (~(uni in targets.u.pals.ctx) leeches.u.pals.ctx)
    :-  ~
    :-  %a
    %+  turn  (sort ~(tap in all) lth)
    |=(k=@p (ship-json k (get-point pos k) ctx))
  ::  /api/peers: every ship our ship knows on the network
  ::
      [%peers ~]
    =/  pos  points:nas
    =/  all=(list @p)
      %+  sort
        ~(tap in (~(uni in ~(key by chums.ctx)) ~(key by peers.ctx)))
      lth
    :-  ~
    :-  %a
    %+  turn  all
    |=(k=@p (ship-json k (get-point pos k) ctx))
  ==
::
::  data access
::
++  get-ctx
  ^-  ctx
  :+  .^(known %ax (bp %$ /chums))
    .^(known %ax (bp %$ /peers))
  ?.  (running %pals)  ~
  :-  ~
  :-  .^((set ship) %gx (bp %pals /targets/noun))
  .^((set ship) %gx (bp %pals /leeches/noun))
::
++  nas  .^(naive-state %gx (bp %azimuth /nas/noun))
++  spo  .^(sponsors %gx (bp %azimuth /spo/noun))
::
++  get-point
  |=  [a=points who=ship]
  ^-  (unit point)
  ?~  a  ~
  ?:  =(who -.n.a)  `+.n.a
  ?:  (por who -.n.a)
    $(a l.a)
  $(a r.a)
::
::  +por: azimuth's "parent order" (galaxy byte, star byte, then rest),
::  which keeps every star's and galaxy's subtree contiguous
::
++  por
  |=  [a=@p b=@p]
  ^-  ?
  ?:  =(a b)  &
  =|  i=@
  |-
  ?:  =(i 2)  (lte a b)
  =+  [c=(end 3 a) d=(end 3 b)]
  ?:  =(c d)
    $(a (rsh 3 a), b (rsh 3 b), i +(i))
  (lth c d)
::
::  +ames-qos: what ames knows about our connection to .who.  a ship
::  can be in both the mesa (chums) and old-ames (peers) tables, and
::  only one of them is current, so take whichever heard most recently
::
++  ames-qos
  |=  [who=ship =ctx]
  ^-  (unit qos)
  =/  c=(unit qos)
    ?.  =(`%known (~(get by chums.ctx) who))  ~
    =/  c  .^(chum-state:ames %ax (bp %$ /chums/(scot %p who)))
    ?.  ?=(%known -.c)  ~
    `[-.qos.+.c last-contact.qos.+.c]
  =/  p=(unit qos)
    ?.  =(`%known (~(get by peers.ctx) who))  ~
    =/  s  .^(ship-state:ames %ax (bp %$ /peers/(scot %p who)))
    ?.  ?=(%known -.s)  ~
    `[-.qos.+.s last-contact.qos.+.s]
  ?~  c  p
  ?~  p  c
  ?:((gth last.u.p last.u.c) p c)
::
::  +status: from our probes only.  ames's own view can't be trusted:
::  it marks any idle peer %dead 30s after the last packet, and stamps
::  last-contact when keys arrive or (under mesa) when we merely send.
::
::    %live:    the last finished probe was answered (last: when)
::    %dead:    the last finished probe went unanswered past +patience
::              (last: when we last heard from them, if ever)
::    %unborn:  never probed, and ames has keys but nothing more
::
::    a probe in flight leaves the previous verdict standing.
::
++  status
  |=  [who=ship =ctx]
  ^-  (unit qos)
  ?:  =(who our.bowl)  `[%live now.bowl]
  =/  p  (~(get by probes) who)
  ?~  p
    =/  a  (ames-qos who ctx)
    ?:(&(?=(^ a) ?=(%unborn kind.u.a)) a ~)
  ::  overdue counts as unanswered even before the yawn timer lands
  ::
  ?:  &((gth sent.u.p got.u.p) (lth sent.u.p (sub now.bowl patience)))
    `[%dead got.u.p]
  ?~  ok.u.p  ~
  `[?:(u.ok.u.p %live %dead) got.u.p]
::
::  +in-flight: probe out and not yet given up on
::
++  in-flight
  |=  p=(unit probe)
  ^-  ?
  ?~  p  |
  &((gth sent.u.p got.u.p) (gth sent.u.p (sub now.bowl patience)))
::
::  +want-probe: is it worth asking .who?
::
++  want-probe
  |=  [who=ship p=(unit probe)]
  ^-  ?
  ?:  =(who our.bowl)  |
  ?~  p  &
  ?:  (gte got.u.p sent.u.p)  (lth got.u.p (sub now.bowl recheck))
  (lth sent.u.p (sub now.bowl (backoff miss.u.p)))
::
++  probe-3-to-4
  |=  p=probe-3
  ^-  probe
  [sent.p got.p ok.p ?:(=(`| ok.p) 1 0)]
::
++  probe-2-to-3
  |=  p=probe-2
  ^-  probe-3
  :+  sent.p  got.p
  ?:  (gte got.p sent.p)  ?:(=(*@da got.p) ~ `&)
  `|
::
::  +send-probes: scry each ship that needs it, with a deadline, keeping
::  at most +max-out in flight; the rest go out on later calls
::
++  send-probes
  |=  who=(list ship)
  (probe-ships who |)
::
::  +probe-ships: .force skips +max-out and +want-probe's waits (but
::  never doubles up on a probe already out)
::
++  probe-ships
  |=  [who=(list ship) force=?]
  ^-  (quip card (map ship probe))
  =/  ps  probes
  =/  out=@ud  (lent (skim ~(val by ps) |=(p=probe (in-flight `p))))
  =|  cards=(list card)
  |-
  ?~  who  [cards ps]
  ?:  &(!force (gte out max-out))  [cards ps]
  =*  w  i.who
  =/  p  (~(get by ps) w)
  ?.  ?:  force  &(!=(w our.bowl) !(in-flight p))
      (want-probe w p)
    $(who t.who)
  =/  wir  /(scot %p w)/(scot %da now.bowl)
  %=  $
    who    t.who
    out    +(out)
    ps     (~(put by ps) w ?~(p [now.bowl *@da ~ 0] u.p(sent now.bowl)))
    cards
      :*  [%pass [%probe wir] %arvo %a %keen ~ w (probe-path now.bowl)]
          [%pass /yawn/(scot %p w)/(scot %da now.bowl) %arvo %b %wait (add now.bowl patience)]
          cards
      ==
  ==
::
::  +auto-targets: who the timer keeps fresh: booted galaxies and pals
::
++  auto-targets
  ^-  (list ship)
  =/  pos  points:nas
  =/  gals=(list ship)
    %+  skim  (turn (gulf 0 255) |=(a=@ `@p`a))
    |=  g=@p
    =/  pin  (get-point pos g)
    &(?=(^ pin) (gth life.keys.net.u.pin 0))
  ?.  (running %pals)  gals
  =/  =ctx  get-ctx
  ?~  pals.ctx  gals
  (weld gals ~(tap in (~(uni in targets.u.pals.ctx) leeches.u.pals.ctx)))
::
::  +parse-ships: a json array of @p strings, deduped, at most 1.000
::
++  parse-ships
  |=  body=(unit octs)
  ^-  (list ship)
  ?~  body  ~
  =/  j  (de:json:html `@t`q.u.body)
  ?~  j  ~
  =/  l  ((ar:dejs-soft:format so:dejs-soft:format) u.j)
  ?~  l  ~
  (scag 1.000 ~(tap in (silt (murn u.l (cury slaw %p)))))
::
::  +statuses: {"~zod": [status, last, waiting], ...}.  waiting: a probe
::  is out, or (for the owner, whose reads send them) one is queued
::
++  statuses
  |=  [who=(list ship) owner=?]
  ^-  json
  =/  =ctx  get-ctx
  :-  %o
  %-  malt
  %+  turn  who
  |=  w=ship
  ^-  [@t json]
  =/  q  (status w ctx)
  =/  p  (~(get by probes) w)
  :-  (scot %p w)
  :-  %a
  :~  ?~(q ~ s+kind.u.q)
      ?~(q ~ ?:(=(*@da last.u.q) ~ (time:enjs:format last.u.q)))
      b+|((in-flight p) &(owner (want-probe w p)))
  ==
::
::  json
::
++  kind
  |=  who=ship
  ^-  @t
  ?-  (clan:title who)
    %czar  'galaxy'
    %king  'star'
    %duke  'planet'
    %earl  'moon'
    %pawn  'comet'
  ==
::
::  +apps-json: allied?, published desks, and their dockets
::
++  apps-json
  |=  who=ship
  ^-  json
  =,  enjs:format
  ?.  (running %treaty)  (pairs ~[treaty+b+|])
  =/  al  .^(ally-update %gx (bp %treaty /allies/ally-update-0))
  =/  ali=(unit (set [@p @tas]))
    ?.  ?=(%ini -.al)  ~
    (~(get by init.al) who)
  =/  tu  .^(treaty-update %gx (bp %treaty /treaties/(scot %p who)/treaty-update-0))
  =/  ts=(list [[@p @tas] treaty])
    ?.  ?=(%ini -.tu)  ~
    ~(tap by init.tu)
  =/  have  .^((set @tas) %cd (bp %$ ~))
  %-  pairs
  :~  treaty+b+&
      allied+b+?=(^ ali)
      desks+a+?~(ali ~ (turn ~(tap in u.ali) |=([s=@p d=@tas] s+d)))
      apps+a+(turn ts |=([[s=@p d=@tas] t=treaty] (app-json s d t have)))
  ==
::
::  +app-json: one published app, as its docket describes it
::
++  app-json
  |=  [s=@p d=@tas t=treaty have=(set @tas)]
  ^-  json
  =,  enjs:format
  =/  k  docket.t
  %-  pairs
  :~  ship+s+(scot %p s)
      desk+s+d
      title+s+title.k
      info+s+info.k
      color+s+(crip ((x-co:co 6) color.k))
      image+?~(image.k ~ s+u.image.k)
      version+s+(crip "{(scow %ud major.version.k)}.{(scow %ud minor.version.k)}.{(scow %ud patch.version.k)}")
      website+s+website.k
      license+s+license.k
      installed+b+(~(has in have) d)
  ==
::
::  +catalog-json: every app our ship knows is published anywhere, and
::  the publishers we follow (allies) with how many desks each lists
::
++  catalog-json
  ^-  json
  =,  enjs:format
  ?.  (running %treaty)  (pairs ~[treaty+b+|])
  =/  al  .^(ally-update %gx (bp %treaty /allies/ally-update-0))
  =/  als=(list [@p (set [@p @tas])])  ?.(?=(%ini -.al) ~ ~(tap by init.al))
  =/  tu  .^(treaty-update %gx (bp %treaty /treaties/treaty-update-0))
  =/  ts=(list [[@p @tas] treaty])  ?.(?=(%ini -.tu) ~ ~(tap by init.tu))
  =/  have  .^((set @tas) %cd (bp %$ ~))
  %-  pairs
  :~  treaty+b+&
      :-  %allies
      :-  %a
      %+  turn  als
      |=  [s=@p ds=(set [@p @tas])]
      (pairs ~[ship+s+(scot %p s) desks+(numb ~(wyt in ds))])
      apps+a+(turn ts |=([[s=@p d=@tas] t=treaty] (app-json s d t have)))
      share+b+share
      hops+(numb hops)
      hits+(hits-json have)
  ==
::
::  +tiny: compact row for /api/tree
::
++  tiny
  |=  [who=ship pos=points =ctx up=(unit [g=@ud n=@ud]) ns=@ud np=@ud]
  ^-  json
  =,  enjs:format
  =/  pin  (get-point pos who)
  =/  q  (status who ctx)
  =/  st=@ud
    ?~  q  0
    ?-  kind.u.q
      %live    1
      %dead    2
      %unborn  3
      %stale   4
    ==
  =/  life=json  ?~(pin (numb 0) (numb life.keys.net.u.pin))
  =/  rel=@ud
    ?~  pals.ctx  0
    %+  add  ?:((~(has in targets.u.pals.ctx) who) 1 0)
    ?:((~(has in leeches.u.pals.ctx) who) 2 0)
  =/  nm=json  s+(scot %p who)
  ?~  up
    a+~[nm (numb st) ?~(pin n+'-1' life) (numb rel) (numb ns) (numb np)]
  a+~[nm (numb g.u.up) (numb (index who)) (numb st) ?~(pin n+'-1' life) (numb rel) (numb n.u.up)]
::
::  +index: slot number within the parent (byte/halfword/word above it)
::
++  index
  |=  who=ship
  ^-  @ud
  ?-  (clan:title who)
    %czar  `@ud`who
    %king  (rsh 3 who)
    %duke  (rsh 4 who)
    %earl  (rsh 5 who)
    %pawn  0
  ==
::
++  ship-json
  |=  [who=ship pin=(unit point) =ctx]
  ^-  json
  =,  enjs:format
  =/  q  (status who ctx)
  %-  pairs
  :~  ship+s+(scot %p who)
      kind+s+(kind who)
      idx+(numb (index who))
      parent+?:(?=(%czar (clan:title who)) ~ s+(scot %p (^sein:title who)))
      status+?~(q ~ s+kind.u.q)
      last+?~(q ~ ?:(=(*@da last.u.q) ~ (time last.u.q)))
      life+?~(pin ~ (numb life.keys.net.u.pin))
      rift+?~(pin ~ (numb rift.net.u.pin))
      layer+?~(pin ~ s+dominion.u.pin)
      sponsor+?~(pin ~ ?.(has.sponsor.net.u.pin ~ s+(scot %p who.sponsor.net.u.pin)))
      escape+?~(pin ~ ?~(escape.net.u.pin ~ s+(scot %p u.escape.net.u.pin)))
      target+?~(pals.ctx ~ b+(~(has in targets.u.pals.ctx) who))
      leech+?~(pals.ctx ~ b+(~(has in leeches.u.pals.ctx) who))
  ==
::
++  detail-json
  |=  [who=ship =ctx]
  ^-  json
  =,  enjs:format
  =/  pin  (get-point points:nas who)
  =/  rez  (~(gut by spo) who [residents=~ requests=~])
  =/  base  (ship-json who pin ctx)
  ?>  ?=(%o -.base)
  :-  %o
  %-  ~(gas by p.base)
  :~  residents+(numb ~(wyt in residents.rez))
      requests+(numb ~(wyt in requests.rez))
      owner+?~(pin ~ (addr address.owner.own.u.pin))
      ['spawnProxy' ?~(pin ~ (addr address.spawn-proxy.own.u.pin))]
      ['managementProxy' ?~(pin ~ (addr address.management-proxy.own.u.pin))]
      chain+a+(turn (saxo who) |=(k=@p s+(scot %p k)))
    ::  palAck: did %pals get an ack for our request? null = waiting
    ::
      :-  %'palAck'
      ?.  (running %pals)  ~
      =/  rec  .^(pal-records %gx (bp %pals /noun))
      =/  a  (~(get by receipts.rec) who)
      ?~(a ~ b+u.a)
  ==
::
::  +my-installs: apps we run that kiln syncs from a publisher, with
::  their dockets.  like %hits, desks with no publisher (|new-desk,
::  installed from a file) don't count, so dev desks stay private.
::
++  my-installs
  ^-  (map [ship desk] app-card)
  =/  pk  .^((map desk pike) %gx (bp %hood /kiln/pikes/kiln-pikes))
  =/  ch=(map desk docket:docket)
    ?.  (running %docket)  ~
    =/  u  .^(charge-update:docket %gx (bp %docket /charges/charge-update))
    ?.  ?=(%initial -.u)  ~
    (~(run by initial.u) |=(c=charge:docket docket.c))
  %-  ~(gas by *(map [ship desk] app-card))
  %+  murn  ~(tap by pk)
  |=  [d=desk p=pike]
  ^-  (unit [[ship desk] app-card])
  ?~  sync.p  ~
  ?.  ?=(%live zest.p)  ~
  ?:  =(ship.u.sync.p our.bowl)  ~
  =/  k  (~(get by ch) d)
  :+  ~  [ship desk]:u.sync.p
  ?~  k  [d '' 0x0 '' '']
  %-  bound-card
  :*  title.u.k  info.u.k  color.u.k
      ?~(image.u.k '' u.image.u.k)
      (crip "{(scow %ud major.version.u.k)}.{(scow %ud minor.version.u.k)}.{(scow %ud patch.version.u.k)}")
  ==
::
::  +sync-installs: stamp new installs and retract removed ones, as hits
::
++  sync-installs
  |=  st=state-5
  ^-  (quip card state-5)
  =/  now-have  my-installs
  =|  cards=(list card)
  =/  new  (skip ~(tap by now-have) |=([k=[ship desk] *] (~(has by mine.st) k)))
  |-
  ?^  new
    =/  h=hit  [(sham eny.bowl p.i.new) p.i.new now.bowl & q.i.new]
    %=  $
      new      t.new
      mine.st  (~(put by mine.st) p.i.new [now.bowl id.h])
      hits.st  (add-hit hits.st h)
      cards    ?.(share.st cards [(invent:gossip %sextant-hit !>(h)) cards])
    ==
  =/  gone  (skip ~(tap by mine.st) |=([k=[ship desk] *] (~(has by now-have) k)))
  |-
  ?~  gone  [(flop cards) st]
  =*  k  p.i.gone
  =/  h=hit  [id.q.i.gone k at.q.i.gone | card:(~(gut by hits.st) k *app-hits)]
  %=  $
    gone     t.gone
    mine.st  (~(del by mine.st) k)
    hits.st  (add-hit hits.st h)
    cards    ?.(share.st cards [(invent:gossip %sextant-hit !>(h)) cards])
  ==
::
::  +bound-card: cap what a peer (or publisher) can make us store
::
++  bound-card
  |=  c=app-card
  ^-  app-card
  :*  (end 3^80 title.c)
      (end 3^240 info.c)
      (end 3^3 color.c)
      ?.(=('https://' (end 3^8 image.c)) '' (end 3^400 image.c))
      (end 3^20 version.c)
  ==
::
::  +add-hit: record a hit we heard (or made), within limits
::
++  add-hit
  |=  [hs=(map [ship desk] app-hits) h=hit]
  ^-  (map [ship desk] app-hits)
  ?.  ((sane %tas) desk.app.h)  hs
  =/  cur  (~(get by hs) app.h)
  ?:  &(?=(~ cur) (gte ~(wyt by hs) 2.000))  hs
  =/  ah=app-hits  (fall cur [(bound-card card.h) ~])
  ?:  &(!(~(has by ids.ah) id.h) (gte ~(wyt by ids.ah) 5.000))  hs
  ::  an id that has been retracted stays retracted
  ::
  =/  was  (~(get by ids.ah) id.h)
  ?:  &(?=(^ was) !on.u.was)  hs
  =/  at  ?:((gth at.h now.bowl) now.bowl at.h)
  =.  ids.ah  (~(put by ids.ah) id.h [at on.h])
  =?  card.ah  &(on.h !=('' title.card.h))  (bound-card card.h)
  (~(put by hs) app.h ah)
::
::  +hits-json: per app, installs heard of and when (for trending)
::
++  hits-json
  |=  have=(set @tas)
  ^-  json
  :-  %a
  %+  murn  ~(tap by hits)
  |=  [[pub=ship dk=desk] ah=app-hits]
  ^-  (unit json)
  =/  ons=(list @da)
    %+  sort
      (murn ~(val by ids.ah) |=([at=@da on=?] ?.(on ~ `at)))
    gth
  ?~  ons  ~
  =/  c  card.ah
  =,  enjs:format
  :-  ~
  %-  pairs
  :~  ship+s+(scot %p pub)
      desk+s+dk
      n+(numb (lent ons))
      at+a+(turn (scag 200 `(list @da)`ons) time)
      mine+b+(~(has by mine) [pub dk])
      installed+b+(~(has in have) dk)
      title+s+?:(=('' title.c) dk title.c)
      info+s+info.c
      color+s+(crip ((x-co:co 6) color.c))
      image+?:(=('' image.c) ~ s+image.c)
      version+s+version.c
  ==
::
::  +saxo: hierarchical chain up to the galaxy (no jael needed)
::
++  saxo
  |=  who=ship
  ^-  (list ship)
  =/  up  (^sein:title who)
  ?:  =(up who)  ~[who]
  [who $(who up)]
::
::  +chain: .who and its current sponsors, up to a galaxy.  comets and
::  moons aren't on azimuth, so they go up by parent.
::
++  chain
  |=  [pos=points who=ship]
  ^-  (list ship)
  =|  out=(list ship)
  =|  n=@ud
  |-
  =.  out  [who out]
  ?:  |(?=(%czar (clan:title who)) (gte n 4))  (flop out)
  =/  pin  (get-point pos who)
  =/  up=ship
    ?.  &(?=(^ pin) has.sponsor.net.u.pin)  (^sein:title who)
    who.sponsor.net.u.pin
  ?:  =(up who)  (flop out)
  $(who up, n +(n))
::
::  +route: the hops a packet climbs from us to .who: up our sponsor
::  chain to where it meets theirs (or to our galaxy), then down theirs
::
++  route
  |=  who=ship
  ^-  (list [ship ?(%us %them %both)])
  =/  pos   points:nas
  =/  us    (chain pos our.bowl)
  =/  them  (chain pos who)
  =/  ts    (silt them)
  =/  up=(list ship)
    =|  acc=(list ship)
    |-
    ?~  us  (flop acc)
    ?:  (~(has in ts) i.us)  (flop [i.us acc])
    $(us t.us, acc [i.us acc])
  =/  m    (rear up)
  =/  met  (~(has in ts) m)
  =/  down=(list ship)
    %-  flop
    ?.  met  them
    (scag (need (find ~[m] them)) them)
  %+  weld
    (turn up |=(s=ship ^-([ship ?(%us %them %both)] [s ?:(&(met =(s m)) %both %us)])))
  (turn down |=(s=ship ^-([ship ?(%us %them %both)] [s %them])))
::
::  +lane-kind: how ames would reach .who: a direct address, only via
::  relays, no address at all (e.g. a galaxy with no dns), or unknown
::
++  lane-kind
  |=  [who=ship =ctx]
  ^-  @t
  ?:  =(who our.bowl)  'self'
  ?:  =(`%known (~(get by peers.ctx) who))
    =/  s  .^(ship-state:ames %ax (bp %$ /peers/(scot %p who)))
    ?.  ?=(%known -.s)  'unknown'
    ?~  route.+.s  'none'
    ?:(direct.u.route.+.s 'direct' 'relayed')
  ?:  =(`%known (~(get by chums.ctx) who))  'mesa'
  'unknown'
::
::  +trace-json: [{ship kind side status last rtt waiting lane}, ...]
::  rtt (ms) is from the last probe, if it has been answered
::
++  trace-json
  |=  who=ship
  ^-  json
  =/  =ctx  get-ctx
  :-  %a
  %+  turn  (route who)
  |=  [hop=ship side=?(%us %them %both)]
  =/  q  (status hop ctx)
  =/  p  (~(get by probes) hop)
  =,  enjs:format
  %-  pairs
  :~  ship+s+(scot %p hop)
      kind+s+(kind hop)
      side+s+side
      status+?~(q ~ s+kind.u.q)
      last+?~(q ~ ?:(=(*@da last.u.q) ~ (time last.u.q)))
    ::
      :-  %rtt
      ?.  &(?=(^ p) (gth got.u.p sent.u.p))  ~
      (numb (div (mul (sub got.u.p sent.u.p) 1.000) ~s1))
    ::
      waiting+b+(in-flight p)
      lane+s+(lane-kind hop ctx)
  ==
::
++  addr
  |=  a=address
  ^-  json
  ?:  =(0 a)  ~
  s+(crip (weld "0x" ((x-co:co 40) a)))
::
++  ping-json
  |=  who=ship
  ^-  json
  =,  enjs:format
  ?.  (running %vitals)
    (pairs state+s+'unavailable' ~)
  =/  r  .^(result:vitals %gx (bp %vitals /ship/(scot %p who)/vitals-result))
  %-  pairs
  :~  state+s+-.status.r
      result+s+-.p.status.r
      at+?:(=(*@da timestamp.r) ~ (time timestamp.r))
  ==
--
