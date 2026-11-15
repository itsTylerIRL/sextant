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
::    ames only updates its view of a peer when packets flow, so on its
::    own it goes stale: a ship we last heard from two weeks ago reads
::    %dead forever.  we keep it fresh by probing: a %noun poke to the
::    other ship's %ping agent (on %base, so every ship has it) which
::    acks foreign pokes and does nothing else.  ack or nack, any answer
::    means they're up.  see +status for how the evidence is weighed.
::
::    moons are not on azimuth, so we only know the moons our ship has
::    talked to (or our own, via jael).
::
/-  vitals, docket
/+  default-agent, dbug, server
|%
+$  versioned-state  $%(state-0 state-1 state-2)
+$  state-0  [%0 public=?]
::  tree: cached /api/tree body, rebuilt by a behn timer; not persisted
::  next: when that timer fires, so a reload can cancel it
::
+$  state-1  [%1 public=? next=(unit @da) tree=(unit octs)]
::  probes: when we last poked a ship's %ping, and when it last answered.
::  sent > got means a probe is still out.
::
+$  state-2
  $:  %2
      public=?
      next=(unit @da)
      tree=(unit octs)
      probes=(map ship probe)
  ==
+$  probe  [sent=@da got=@da]
::  how fresh is fresh
::
++  fresh     ~m15  ::  heard from this recently: live
++  patience  ~s45  ::  probe unanswered this long: offline
++  recheck   ~m5   ::  don't probe a ship heard from this recently
++  giveup    ~h1   ::  resend a probe unanswered this long
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
%-  agent:dbug
=|  state-2
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
  =/  new=state-2
    ?-  -.old
      %0  [%2 public.old ~ ~ ~]
      %1  [%2 public.old next.old ~ ~]
      %2  old(tree ~)
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
      (json-response:gen:server (statuses:hc who))
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
  (on-watch:def path)
::
++  on-arvo
  |=  [=wire =sign-arvo]
  ^-  (quip card _this)
  ?:  ?=([%tree ~] wire)
    ?>  ?=([%behn %wake *] sign-arvo)
    =/  nex  (add now.bowl ~m5)
    ::  keep our pals and the galaxies fresh without being asked
    ::
    =^  cards  probes  (send-probes:hc auto-targets:hc)
    :-  [[%pass /tree %arvo %b %wait nex] cards]
    this(next `nex, tree `tree-octs:hc)
  ?.  ?=([%eyre %connect ~] wire)  (on-arvo:def wire sign-arvo)
  ?>  ?=([%eyre %bound *] sign-arvo)
  ~?  !accepted.sign-arvo  [dap.bowl %eyre-bind-failed binding.sign-arvo]
  `this
::
++  on-agent
  |=  [=wire =sign:agent:gall]
  ^-  (quip card _this)
  ?:  ?=([%probe @ ~] wire)
    ::  ack or nack, they answered
    ::
    =/  who  (slaw %p i.t.wire)
    ?.  &(?=(^ who) ?=(%poke-ack -.sign))  `this
    =/  p=probe  (~(gut by probes) u.who [now.bowl *@da])
    `this(probes (~(put by probes) u.who p(got now.bowl)))
  ?.  ?=([?(%ping %pal %ally %install) *] wire)  (on-agent:def wire sign)
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
::  +heard: when they last provably answered: a probe ack, or a packet
::  ames received.  ames's last-contact alone isn't proof: it's also
::  stamped when keys first arrive, before any contact, and survives
::  ames marking the peer %dead after 30s of quiet.  only %live means
::  last-contact was a real packet.
::
++  heard
  |=  [a=(unit qos) p=(unit probe)]
  ^-  @da
  %+  max  ?~(p *@da got.u.p)
  ?:(&(?=(^ a) ?=(%live kind.u.a)) last.u.a *@da)
::
::  +status: ames plus our probes, weighed by age
::
::    %dead:    a probe has gone unanswered past +patience
::    %live:    they answered within +fresh
::    %stale:   everything we know is older than that
::    %unborn:  ames has their keys, nothing more
::
::    ames's own %dead is ignored: it marks any idle peer %dead 30s
::    after the last packet, so it means "quiet", not "offline".
::
++  status
  |=  [who=ship =ctx]
  ^-  (unit qos)
  ?:  =(who our.bowl)  `[%live now.bowl]
  =/  a  (ames-qos who ctx)
  =/  p  (~(get by probes) who)
  =/  h  (heard a p)
  ?:  ?&  ?=(^ p)
          (gth sent.u.p h)
          (lth sent.u.p (sub now.bowl patience))
      ==
    `[%dead h]
  ?:  (gth h (sub now.bowl fresh))  `[%live h]
  ?~  a  ?~(p ~ `[%stale h])
  ?:  &(?=(~ p) ?=(%unborn kind.u.a))  a
  `[%stale (max h last.u.a)]
::
::  +want-probe: is it worth poking .who to find out?
::
++  want-probe
  |=  [who=ship =ctx p=(unit probe)]
  ^-  ?
  ?:  =(who our.bowl)  |
  ?:  (gth (heard (ames-qos who ctx) p) (sub now.bowl recheck))  |
  ?~  p  &
  ::  one already out: ames retries it, so just wait (within reason)
  ::
  ?.  (gth sent.u.p got.u.p)  &
  (lth sent.u.p (sub now.bowl giveup))
::
::  +send-probes: poke %ping on each ship that needs it
::
++  send-probes
  |=  who=(list ship)
  ^-  (quip card (map ship probe))
  =/  =ctx  get-ctx
  =/  ps  probes
  =|  cards=(list card)
  |-
  ?~  who  [cards ps]
  =*  w  i.who
  =/  p  (~(get by ps) w)
  ?.  (want-probe w ctx p)  $(who t.who)
  %=  $
    who    t.who
    ps     (~(put by ps) w [now.bowl ?~(p *@da got.u.p)])
    cards  [[%pass /probe/(scot %p w) %agent [w %ping] %poke %noun !>(~)] cards]
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
::  +statuses: {"~zod": [status, last, probing], ...}
::
++  statuses
  |=  who=(list ship)
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
      b+?~(p | (gth sent.u.p got.u.p))
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
      :-  %apps
      :-  %a
      %+  turn  ts
      |=  [[s=@p d=@tas] t=treaty]
      =/  k  docket.t
      %-  pairs
      :~  desk+s+d
          title+s+title.k
          info+s+info.k
          color+s+(crip ((x-co:co 6) color.k))
          image+?~(image.k ~ s+u.image.k)
          version+s+(crip "{(scow %ud major.version.k)}.{(scow %ud minor.version.k)}.{(scow %ud patch.version.k)}")
          website+s+website.k
          license+s+license.k
          installed+b+(~(has in have) d)
      ==
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
::  +saxo: hierarchical chain up to the galaxy (no jael needed)
::
++  saxo
  |=  who=ship
  ^-  (list ship)
  =/  up  (^sein:title who)
  ?:  =(up who)  ~[who]
  [who $(who up)]
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
