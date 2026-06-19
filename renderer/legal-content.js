'use strict';
// ─── FLUX legal content (Terms of Use + Privacy Policy) ──────────────────────
// Drafted by counsel for FLUX as a DESKTOP APPLICATION (no server / website).
// Italian is the only legally binding version; English is a courtesy translation
// (a non-binding banner is prepended by buildTOSHtml when shown).
//
// Clause numbering MUST stay stable — the art. 1341 c.c. second-acceptance flag
// specifically approves clauses 1, 3, 4, 6, 7 (Part I) and 10 (Part II).
//
// All operator fill-ins (Titolare name/address, contact + takedown + rights
// e-mail, revision date) were completed on 2026-06-19 — there are no remaining
// <mark class="tos-fill"> YELLOW placeholders. The _FILL helper is kept for any
// future field that needs highlighting before completion.
// Contact e-mail = flux.hub.app@gmail.com (confirmed 2026-06-19), used in §4.4 (takedown),
// Privacy §1 (Titolare contact) and §7 (GDPR rights). Must be an actively-monitored inbox.

const _FILL = s => `<mark class="tos-fill">${s}</mark>`;

const TOS_IT = `
<h2>Termini e Condizioni d'Uso e Privacy Policy</h2>

<h2>PARTE I – TERMINI E CONDIZIONI D'USO</h2>

<h3>1. Informazioni sulla Piattaforma e accettazione dei Termini</h3>
<p>FLUX Hub (da ora solo "FLUX", di seguito anche "la Piattaforma") è un software open source gratuito che opera esclusivamente come motore di ricerca e aggregatore di metadati. La Piattaforma non ospita, non memorizza, non trasmette e non distribuisce alcun contenuto multimediale. Essa si limita a interrogare risorse di terze parti (tra cui reti BitTorrent e piattaforme di streaming video) e a restituire all'utente i risultati delle interrogazioni effettuate autonomamente dai sistemi remoti.</p>
<p>L'utilizzo della Piattaforma implica la piena e incondizionata accettazione dei presenti Termini e Condizioni d'Uso (di seguito "T&amp;C"). Chiunque non intenda accettare i presenti T&amp;C è tenuto ad astenersi dall'utilizzo della Piattaforma.</p>

<h3>2. Natura tecnica e giuridica del servizio</h3>
<h4>2.1 Qualificazione tecnica</h4>
<p>La Piattaforma svolge un'attività di natura meramente tecnica, automatica e passiva, assimilabile a quella di un motore di ricerca o di un aggregatore di indici. In particolare:</p>
<ul>
  <li>La Piattaforma non carica, non memorizza e non mette a disposizione del pubblico alcun contenuto protetto dal diritto d'autore;</li>
  <li>La Piattaforma non conosce né controlla i contenuti presenti sui siti terzi cui indirizza l'utente;</li>
  <li>L'attività della Piattaforma si esaurisce nel trasmettere query a sistemi remoti e nel restituire i risultati prodotti autonomamente da tali sistemi;</li>
  <li>I file torrent e i contenuti musicali accessibili tramite la Piattaforma risiedono esclusivamente su infrastrutture di terze parti, indipendenti dal gestore della Piattaforma.</li>
</ul>
<h4>2.2 Qualificazione giuridica</h4>
<p>In considerazione della propria natura tecnica, la Piattaforma non rientra nella definizione di "prestatore di servizi di condivisione di contenuti online" ai sensi dell'art. 102-sexies della Legge 22 aprile 1941, n. 633 (di seguito "L.d.A."), introdotto dal D.Lgs. 8 novembre 2021, n. 177, non presentando i requisiti cumulativi ivi previsti e, in particolare, non avendo come scopo principale la memorizzazione e la messa a disposizione del pubblico di opere protette caricate dagli utenti, né perseguendo finalità di profitto diretto o indiretto derivante dall'organizzazione di tali contenuti.</p>
<p>Il servizio offerto è compatibile con il regime di esonero dalla responsabilità previsto dall'art. 14 della Direttiva 2000/31/CE e dall'art. 16 del D.Lgs. 9 aprile 2003, n. 70, in quanto il gestore non svolge un ruolo attivo idoneo a conferirgli conoscenza o controllo dei contenuti accessibili tramite la Piattaforma [C-682/18, 22/06/2021].</p>

<h3>3. Utilizzo lecito della Piattaforma – Regole fondamentali</h3>
<h4>3.1 Principio generale</h4>
<p>L'utente si impegna a utilizzare la Piattaforma esclusivamente per scopi leciti e nel rispetto della normativa vigente in materia di diritto d'autore, con particolare riferimento alla L.d.A. e alla Direttiva 2001/29/CE.</p>
<p>La Piattaforma è uno strumento neutro: la sua liceità dipende esclusivamente dall'uso che ciascun utente ne fa. Il gestore non risponde degli usi illeciti effettuati dagli utenti in violazione dei presenti T&amp;C.</p>
<h4>3.2 Regole specifiche per l'utilizzo tramite rete BitTorrent</h4>
<p>L'utente è consapevole che la rete BitTorrent è una tecnologia di distribuzione peer-to-peer che, in sé, non è né lecita né illecita. La liceità del suo utilizzo dipende integralmente dalla natura dei contenuti scaricati o condivisi.</p>
<p><strong>È consentito</strong> scaricare tramite la rete BitTorrent:</p>
<ul>
  <li>Opere di pubblico dominio (i diritti patrimoniali d'autore durano per tutta la vita dell'autore e per 70 anni dopo la sua morte – art. 25 L.d.A.). L'utente ha l'obbligo di verificare autonomamente la sussistenza del pubblico dominio prima di effettuare qualsiasi download;</li>
  <li>Opere distribuite con licenze libere (es. Creative Commons, GNU GPL), nel rispetto dei termini specifici della licenza applicabile;</li>
  <li>Software open source che consente espressamente la copia e la redistribuzione;</li>
  <li>Contenuti di cui l'utente è titolare dei diritti;</li>
  <li>Contenuti esplicitamente liberati dall'avente diritto.</li>
</ul>
<p><strong>È tassativamente vietato</strong> scaricare tramite la rete BitTorrent:</p>
<ul>
  <li>Film, serie televisive, videogiochi, software commerciale, libri, opere musicali o qualsiasi altro contenuto protetto dal diritto d'autore senza l'autorizzazione del titolare dei diritti;</li>
  <li>Contenuti per i quali i diritti patrimoniali d'autore non siano ancora scaduti e per i quali non sussista alcuna licenza libera o autorizzazione specifica;</li>
  <li>Qualsiasi contenuto ottenuto da fonti illecite. La Corte di Giustizia UE ha chiarito che la normativa sul diritto d'autore osta alla riproduzione di materiali protetti effettuata a partire da fonti illecite [C-435/12, 10/04/2014].</li>
</ul>
<h4>3.3 Regole specifiche per il download di musica tramite YouTube</h4>
<p>Il download di contenuti musicali da YouTube tramite strumenti di terze parti deve essere valutato sia alla luce dei Termini di Servizio di YouTube sia della normativa sul diritto d'autore.</p>
<p><strong>Musica che può essere scaricata lecitamente:</strong></p>
<ul>
  <li>Brani di pubblico dominio (i diritti connessi del produttore fonografico e degli artisti interpreti durano 50 anni – artt. 75 e ss. L.d.A.);</li>
  <li>Brani distribuiti con licenza Creative Commons o altra licenza libera, previa verifica della licenza indicata dall'autore;</li>
  <li>Contenuti di cui l'utente è personalmente titolare dei diritti;</li>
  <li>Librerie royalty-free (es. YouTube Audio Library), nei limiti e alle condizioni indicate dalla libreria;</li>
  <li>Copia privata per uso esclusivamente personale ai sensi dell'art. 71-sexies L.d.A., senza scopo di lucro, nel rispetto delle misure tecnologiche di protezione. La copia privata non autorizza la distribuzione o la condivisione con terzi, non è consentita ove l'accesso sia subordinato a misure tecnologiche di protezione, e non può essere effettuata da terzi per conto dell'utente.</li>
</ul>
<p><strong>È tassativamente vietato:</strong></p>
<ul>
  <li>Scaricare musica protetta da copyright senza l'autorizzazione del titolare dei diritti;</li>
  <li>Distribuire, vendere, trasmettere o mettere a disposizione di terzi i contenuti scaricati, anche se a titolo di copia privata;</li>
  <li>Eludere o aggirare le misure tecnologiche di protezione (DRM) eventualmente applicate.</li>
</ul>

<h3>4. Esclusione di responsabilità del gestore</h3>
<h4>4.1 Assenza di responsabilità per i contenuti di terzi</h4>
<p>Il gestore della Piattaforma non è responsabile dei contenuti presenti sui siti e sulle risorse di terze parti a cui la Piattaforma indirizza l'utente. In conformità ai principi della Corte di Giustizia UE [C-682/18, 22/06/2021] e della giurisprudenza nazionale [Cass. Civ., Sez. 1, n. 7708 del 19/03/2019], il gestore di uno strumento tecnico passivo che si limiti a indicizzare e a reindirizzare l'utente verso risorse di terzi non effettua alcun atto di comunicazione al pubblico e non è responsabile delle violazioni eventualmente compiute, salvo che abbia concreta conoscenza dell'illiceità specifica e non si attivi prontamente.</p>
<h4>4.2 Responsabilità esclusiva dell'utente per gli usi illeciti</h4>
<p>L'utente è l'unico ed esclusivo responsabile di qualsiasi utilizzo illecito che faccia della Piattaforma, ivi incluso il download non autorizzato di contenuti protetti. Il gestore declina ogni responsabilità per violazioni del diritto d'autore, violazioni dei Termini di Servizio di terze parti (incluso YouTube), danni a terzi e sanzioni civili, penali o amministrative irrogate all'utente in conseguenza di usi illeciti della Piattaforma.</p>
<p>L'utente si impegna a manlevare e tenere indenne il gestore da qualsiasi pretesa, azione, danno, perdita, costo o spesa (incluse le spese legali) derivante dall'utilizzo illecito della Piattaforma da parte dell'utente stesso.</p>
<h4>4.3 Assenza di obbligo di sorveglianza</h4>
<p>In conformità all'art. 15 della Direttiva 2000/31/CE e all'art. 17 del D.Lgs. n. 70/2003, il gestore non è soggetto a un obbligo generale di sorveglianza sui contenuti accessibili tramite la Piattaforma, né ha l'obbligo di ricercare attivamente fatti o circostanze che indichino la presenza di attività illecite.</p>
<h4>4.4 Procedura di notifica e rimozione (Notice and Takedown)</h4>
<p>Qualora il titolare di diritti d'autore o un soggetto legittimato ritenga che la Piattaforma stia indicizzando o indirizzando verso contenuti illeciti, potrà inviare una segnalazione motivata e specifica all'indirizzo: flux.hub.app@gmail.com.</p>
<p>La segnalazione dovrà contenere: l'identificazione precisa del contenuto (URL o identificativo univoco); l'indicazione del diritto leso e dei titoli di legittimazione del segnalante; la dichiarazione che il contenuto è stato comunicato al pubblico senza autorizzazione. Segnalazioni generiche, indeterminate o prive degli elementi essenziali non potranno essere elaborate.</p>

<h3>5. Natura open source e assenza di garanzie</h3>
<p>La Piattaforma è distribuita come software open source "così com'è" (as-is), senza garanzie di alcun tipo, esplicite o implicite. Il gestore non garantisce la continuità o disponibilità del servizio, l'accuratezza dei risultati di ricerca, la liceità dei contenuti presenti sui siti terzi, né l'assenza di virus o malware su tali siti.</p>

<h3>6. Modifiche ai Termini e Condizioni</h3>
<p>Il gestore si riserva il diritto di modificare i presenti T&amp;C in qualsiasi momento. Le modifiche saranno pubblicate sulla Piattaforma e avranno efficacia dalla data di pubblicazione. L'utilizzo continuato della Piattaforma successivamente alla pubblicazione delle modifiche implica l'accettazione delle stesse.</p>

<h3>7. Legge applicabile e Foro competente</h3>
<p>I presenti T&amp;C sono regolati dalla legge italiana. Per qualsiasi controversia relativa all'interpretazione o all'esecuzione dei presenti T&amp;C sarà competente il Foro di Roma, salvo diversa disposizione inderogabile di legge.</p>

<h2>PARTE II – PRIVACY POLICY</h2>
<p><em>(redatta in conformità al Regolamento UE 2016/679 – GDPR e al D.Lgs. 30 giugno 2003, n. 196, come modificato dal D.Lgs. 10 agosto 2018, n. 101)</em></p>
<p><em>FLUX è un'applicazione desktop che viene eseguita localmente sul dispositivo dell'utente. Il gestore non gestisce alcun server applicativo che raccolga i dati degli utenti: le impostazioni, la cronologia e i file restano sul dispositivo dell'utente, e le query sono inviate direttamente dal dispositivo ai sistemi di terze parti.</em></p>

<h3>1. Titolare del trattamento</h3>
<p>Il Titolare del trattamento dei dati personali è: Enrico Tommasini, Via Roma 112, 52046 Lucignano (AR), Italia, flux.hub.app@gmail.com (di seguito "Titolare").</p>

<h3>2. Tipologie di dati trattati</h3>
<p>Trattandosi di applicazione eseguita localmente, il Titolare non raccoglie tramite un proprio server dati di navigazione (quali indirizzo IP, dati del browser o cronologia). In particolare:</p>
<ul>
  <li><strong>Dati gestiti localmente:</strong> impostazioni, coda dei download e cronologia sono salvati esclusivamente in locale sul dispositivo dell'utente e non sono trasmessi al Titolare.</li>
  <li><strong>Query di ricerca:</strong> le ricerche inserite dall'utente sono trasmesse, in forma tecnica e automatica, direttamente dal dispositivo dell'utente ai sistemi di terze parti interrogati (reti BitTorrent, piattaforme video). Tale trasmissione può comportare la comunicazione dell'indirizzo IP dell'utente ai server remoti: ciò avviene al di fuori del controllo del Titolare.</li>
  <li><strong>Dati forniti volontariamente:</strong> qualora l'utente invii una comunicazione o una segnalazione agli indirizzi indicati nel presente documento, fornirà volontariamente i dati personali in essa contenuti (es. nome, indirizzo e-mail), trattati esclusivamente per riscontrare la richiesta.</li>
</ul>

<h3>3. Finalità e base giuridica del trattamento</h3>
<ul>
  <li>Funzionamento tecnico dell'applicazione — esecuzione di un contratto (art. 6, par. 1, lett. b GDPR);</li>
  <li>Riscontro a comunicazioni e segnalazioni degli utenti — esecuzione di un contratto / legittimo interesse (art. 6, par. 1, lett. b e f GDPR);</li>
  <li>Adempimento di obblighi di legge — obbligo legale (art. 6, par. 1, lett. c GDPR).</li>
</ul>

<h3>4. Conservazione dei dati</h3>
<p>I dati gestiti localmente permangono sul dispositivo dell'utente finché questi non li elimini (disinstallando l'applicazione o cancellando i dati locali). I dati forniti volontariamente al Titolare in occasione di una comunicazione sono conservati per il tempo necessario alla gestione della richiesta e, successivamente, per il periodo previsto dalle disposizioni legali applicabili.</p>

<h3>5. Comunicazione e diffusione dei dati</h3>
<p>I dati personali degli utenti non sono comunicati a terzi per finalità commerciali o promozionali. Possono essere comunicati a:</p>
<ul>
  <li>Autorità giudiziarie e di pubblica sicurezza, su richiesta e nei casi previsti dalla legge;</li>
  <li>Terze parti destinatarie delle query: le interrogazioni tecniche trasmesse dal dispositivo dell'utente ai sistemi di terze parti possono comportare la trasmissione dell'indirizzo IP ai server remoti, in modo tecnico e automatico. Il Titolare non ha controllo sulle modalità di trattamento dei dati effettuato da tali terze parti; si invita l'utente a consultarne le rispettive privacy policy.</li>
</ul>

<h3>6. Trasferimento di dati verso Paesi terzi</h3>
<p>Qualora le terze parti interrogate dall'applicazione abbiano sede al di fuori dell'Unione Europea o dello Spazio Economico Europeo, la trasmissione tecnica dei dati (in particolare dell'indirizzo IP) verso tali paesi potrà avvenire in ragione del funzionamento tecnico del servizio. Il Titolare non è in grado di garantire le medesime tutele previste dal GDPR per i trattamenti effettuati da tali soggetti terzi.</p>

<h3>7. Diritti dell'interessato</h3>
<p>L'utente, in qualità di interessato ai sensi del GDPR, ha diritto di accesso (art. 15), rettifica (art. 16), cancellazione (art. 17), limitazione (art. 18), portabilità (art. 20), opposizione (art. 21) e revoca del consenso ove applicabile. Per esercitare i propri diritti può contattare il Titolare all'indirizzo: flux.hub.app@gmail.com. L'utente ha altresì il diritto di proporre reclamo al Garante per la Protezione dei Dati Personali (www.garanteprivacy.it).</p>

<h3>8. Cookie e tecnologie di tracciamento</h3>
<p>L'applicazione desktop FLUX non utilizza cookie né tecnologie di tracciamento web a fini di profilazione o pubblicitari. Le preferenze dell'utente sono salvate localmente sul dispositivo (file di configurazione) al solo fine del funzionamento dell'applicazione.</p>

<h3>9. Sicurezza dei dati</h3>
<p>Il Titolare adotta misure tecniche e organizzative adeguate a garantire un livello di sicurezza appropriato al rischio, ai sensi dell'art. 32 GDPR, per proteggere i dati personali da accessi non autorizzati, perdita, distruzione o divulgazione accidentale.</p>

<h3>10. Modifiche alla Privacy Policy</h3>
<p>Il Titolare si riserva il diritto di aggiornare la presente Privacy Policy in qualsiasi momento, anche in conseguenza di modifiche normative. La versione aggiornata sarà pubblicata sulla Piattaforma con indicazione della data di ultimo aggiornamento.</p>
<p>Data di ultima revisione: 19 giugno 2026.</p>

<h2>CREDITI</h2>
<ul>
  <li><strong><a href="https://digitalesmart.it" target="_blank" rel="noopener">Digitale Smart</a></strong> e <strong><a href="https://tid.swiss" target="_blank" rel="noopener">TID</a></strong> — stack tecnologico.</li>
  <li><strong>Iwona Ciardullo Kos</strong> — competenze legali.</li>
  <li><strong><a href="https://pixabay.com/it/users/magiaz-10236927/?utm_source=link-attribution&amp;utm_medium=referral&amp;utm_campaign=music&amp;utm_content=405761" target="_blank" rel="noopener">Mauricio Póvoa</a></strong> — audio dello splash (via <a href="https://pixabay.com/sound-effects//?utm_source=link-attribution&amp;utm_medium=referral&amp;utm_campaign=music&amp;utm_content=405761" target="_blank" rel="noopener">Pixabay</a>).</li>
</ul>
`;

const TOS_EN = `
<h2>Terms of Use and Privacy Policy</h2>

<h2>PART I – TERMS OF USE</h2>

<h3>1. Information about the Platform and acceptance of the Terms</h3>
<p>FLUX Hub (hereinafter "FLUX", also the "Platform") is a free, open-source software that operates exclusively as a search engine and metadata aggregator. The Platform does not host, store, transmit or distribute any media content. It merely queries third-party resources (including BitTorrent networks and video streaming platforms) and returns to the user the results produced autonomously by those remote systems.</p>
<p>Use of the Platform implies full and unconditional acceptance of these Terms of Use ("T&amp;C"). Anyone who does not intend to accept these T&amp;C must refrain from using the Platform.</p>

<h3>2. Technical and legal nature of the service</h3>
<h4>2.1 Technical qualification</h4>
<p>The Platform carries out an activity that is purely technical, automatic and passive, comparable to that of a search engine or an index aggregator. In particular:</p>
<ul>
  <li>The Platform does not upload, store or make available to the public any copyright-protected content;</li>
  <li>The Platform neither knows nor controls the content present on the third-party sites it directs the user to;</li>
  <li>The Platform's activity is limited to transmitting queries to remote systems and returning the results those systems produce autonomously;</li>
  <li>Torrent files and music content accessible through the Platform reside exclusively on third-party infrastructure, independent of the Platform operator.</li>
</ul>
<h4>2.2 Legal qualification</h4>
<p>Given its technical nature, the Platform does not fall within the definition of an "online content-sharing service provider" under art. 102-sexies of Italian Law no. 633/1941 ("L.d.A."), as it does not meet the cumulative requirements set out therein and, in particular, does not have as its main purpose the storage and making available to the public of protected works uploaded by users, nor does it pursue profit from the organisation of such content.</p>
<p>The service is compatible with the liability-exemption regime under art. 14 of Directive 2000/31/EC and art. 16 of Italian Legislative Decree no. 70/2003, since the operator does not play an active role giving it knowledge or control of the content accessible through the Platform [CJEU C-682/18, 22/06/2021].</p>

<h3>3. Lawful use of the Platform – Fundamental rules</h3>
<h4>3.1 General principle</h4>
<p>The user undertakes to use the Platform exclusively for lawful purposes and in compliance with applicable copyright law, in particular the L.d.A. and Directive 2001/29/EC. The Platform is a neutral tool: its lawfulness depends solely on how each user uses it. The operator is not liable for unlawful uses made by users in breach of these T&amp;C.</p>
<h4>3.2 Specific rules for use via the BitTorrent network</h4>
<p>BitTorrent is a peer-to-peer distribution technology that is, in itself, neither lawful nor unlawful; the lawfulness of its use depends entirely on the nature of the content downloaded or shared.</p>
<p><strong>It is permitted</strong> to download via BitTorrent: public-domain works (economic copyright lasts for the author's life plus 70 years – art. 25 L.d.A.; the user must verify public-domain status before any download); works under free licences (e.g. Creative Commons, GNU GPL), subject to the specific licence terms; open-source software; content the user owns the rights to; content explicitly released by the rightsholder.</p>
<p><strong>It is strictly forbidden</strong> to download via BitTorrent: films, TV series, video games, commercial software, books, musical works or any other copyright-protected content without the rightsholder's authorisation; content whose economic copyright has not yet expired and for which no free licence or specific authorisation exists; any content obtained from unlawful sources (the CJEU has held that copyright law precludes reproduction of protected material made from unlawful sources [C-435/12, 10/04/2014]).</p>
<h4>3.3 Specific rules for downloading music via YouTube</h4>
<p>Downloading music from YouTube via third-party tools must be assessed in light of both YouTube's Terms of Service and copyright law.</p>
<p><strong>Music that may be downloaded lawfully:</strong> public-domain tracks (related rights of phonogram producers and performers last 50 years – arts. 75 ff. L.d.A.); tracks under Creative Commons or other free licences, after verifying the licence stated by the author; content the user personally owns the rights to; royalty-free libraries (e.g. the YouTube Audio Library), within their stated terms; private copying for strictly personal use under art. 71-sexies L.d.A., for non-profit purposes and respecting technical protection measures. Private copying does not authorise distribution or sharing with third parties, is not permitted where access is subject to technical protection measures, and may not be carried out by third parties on the user's behalf.</p>
<p><strong>It is strictly forbidden</strong> to: download copyright-protected music without the rightsholder's authorisation; distribute, sell, transmit or make available to third parties downloaded content, even if obtained as a private copy; circumvent technical protection measures (DRM).</p>

<h3>4. Exclusion of the operator's liability</h3>
<h4>4.1 No liability for third-party content</h4>
<p>The operator is not responsible for the content on the third-party sites and resources the Platform directs the user to. In accordance with CJEU principles [C-682/18, 22/06/2021] and national case law [Italian Court of Cassation, Civ. Sec. 1, no. 7708 of 19/03/2019], the operator of a passive technical tool that merely indexes and redirects the user to third-party resources performs no act of communication to the public and is not liable for any infringements committed, unless it has actual knowledge of the specific unlawfulness and fails to act promptly.</p>
<h4>4.2 User's sole responsibility for unlawful uses</h4>
<p>The user is the sole and exclusive party responsible for any unlawful use of the Platform, including the unauthorised download of protected content. The operator disclaims all liability for copyright infringements, breaches of third-party Terms of Service (including YouTube), damage to third parties, and any civil, criminal or administrative penalties imposed on the user as a result of unlawful use of the Platform.</p>
<p>The user undertakes to indemnify and hold the operator harmless from any claim, action, damage, loss, cost or expense (including legal fees) arising from the user's unlawful use of the Platform.</p>
<h4>4.3 No general monitoring obligation</h4>
<p>In accordance with art. 15 of Directive 2000/31/EC and art. 17 of Legislative Decree no. 70/2003, the operator is not subject to a general obligation to monitor the content accessible through the Platform, nor to actively seek facts or circumstances indicating unlawful activity.</p>
<h4>4.4 Notice and Takedown procedure</h4>
<p>If a rightsholder or authorised party believes the Platform is indexing or directing toward unlawful content, they may send a reasoned and specific notice to: flux.hub.app@gmail.com.</p>
<p>The notice must contain: precise identification of the content (specific URL or unique identifier); the right infringed and the notifier's standing; a statement that the content was communicated to the public without authorisation. Generic, vague or incomplete notices cannot be processed.</p>

<h3>5. Open-source nature and absence of warranties</h3>
<p>The Platform is distributed as open-source software "as-is", without warranties of any kind, express or implied. The operator does not warrant the continuity or availability of the service, the accuracy of search results, the lawfulness of content on third-party sites, or the absence of viruses or malware on such sites.</p>

<h3>6. Changes to the Terms and Conditions</h3>
<p>The operator reserves the right to modify these T&amp;C at any time. Changes will be published on the Platform and take effect from the date of publication. Continued use of the Platform after publication of the changes implies acceptance of them.</p>

<h3>7. Governing law and jurisdiction</h3>
<p>These T&amp;C are governed by Italian law. Any dispute relating to the interpretation or performance of these T&amp;C shall fall under the jurisdiction of the Court of Rome, save for any mandatory provision of law to the contrary.</p>

<h2>PART II – PRIVACY POLICY</h2>
<p><em>(prepared in accordance with EU Regulation 2016/679 – GDPR and Italian Legislative Decree no. 196/2003, as amended by Legislative Decree no. 101/2018)</em></p>
<p><em>FLUX is a desktop application that runs locally on the user's device. The operator does not run any application server that collects users' data: settings, history and files remain on the user's device, and queries are sent directly from the device to third-party systems.</em></p>

<h3>1. Data Controller</h3>
<p>The Data Controller is: Enrico Tommasini, Via Roma 112, 52046 Lucignano (AR), Italy, flux.hub.app@gmail.com (the "Controller").</p>

<h3>2. Categories of data processed</h3>
<p>As this is a locally-run application, the Controller does not collect navigation data (such as IP address, browser data or history) through any server of its own. In particular:</p>
<ul>
  <li><strong>Locally-managed data:</strong> settings, the download queue and history are stored exclusively on the user's device and are not transmitted to the Controller.</li>
  <li><strong>Search queries:</strong> searches entered by the user are transmitted, technically and automatically, directly from the user's device to the third-party systems queried (BitTorrent networks, video platforms). This may involve disclosing the user's IP address to remote servers, which occurs outside the Controller's control.</li>
  <li><strong>Voluntarily-provided data:</strong> if the user sends a communication or notice to the addresses indicated in this document, they voluntarily provide the personal data contained therein (e.g. name, e-mail), processed solely to respond to the request.</li>
</ul>

<h3>3. Purposes and legal basis</h3>
<ul>
  <li>Technical operation of the application — performance of a contract (art. 6(1)(b) GDPR);</li>
  <li>Responding to users' communications and notices — performance of a contract / legitimate interest (art. 6(1)(b) and (f) GDPR);</li>
  <li>Compliance with legal obligations — legal obligation (art. 6(1)(c) GDPR).</li>
</ul>

<h3>4. Data retention</h3>
<p>Locally-managed data remain on the user's device until the user deletes them (by uninstalling the application or clearing local data). Data voluntarily provided to the Controller when contacting it are kept for the time needed to handle the request and, thereafter, for the period required by applicable law.</p>

<h3>5. Disclosure of data</h3>
<p>Users' personal data are not disclosed to third parties for commercial or promotional purposes. They may be disclosed to judicial and public-security authorities, on request and in the cases provided by law; and to the third parties receiving the queries — the technical queries sent from the user's device to third-party systems may involve transmitting the IP address to remote servers, technically and automatically. The Controller has no control over how such third parties process data; users are invited to consult their respective privacy policies.</p>

<h3>6. Transfer of data to third countries</h3>
<p>Where the third parties queried by the application are located outside the European Union or the European Economic Area, the technical transmission of data (in particular the IP address) to those countries may occur as part of the technical operation of the service. The Controller cannot guarantee the same safeguards provided by the GDPR for processing carried out by such third parties.</p>

<h3>7. Rights of the data subject</h3>
<p>The user, as a data subject under the GDPR, has the right of access (art. 15), rectification (art. 16), erasure (art. 17), restriction (art. 18), portability (art. 20), objection (art. 21) and withdrawal of consent where applicable. To exercise these rights, contact the Controller at: flux.hub.app@gmail.com. The user also has the right to lodge a complaint with the Italian Data Protection Authority (www.garanteprivacy.it).</p>

<h3>8. Cookies and tracking technologies</h3>
<p>The FLUX desktop application uses no cookies or web tracking technologies for profiling or advertising. User preferences are stored locally on the device (configuration file) solely for the operation of the application.</p>

<h3>9. Data security</h3>
<p>The Controller adopts technical and organisational measures appropriate to the risk, under art. 32 GDPR, to protect personal data from unauthorised access, loss, destruction or accidental disclosure.</p>

<h3>10. Changes to the Privacy Policy</h3>
<p>The Controller reserves the right to update this Privacy Policy at any time, including following legislative changes. The updated version will be published on the Platform with the date of last update.</p>
<p>Last revised: 19 June 2026.</p>

<h2>CREDITS</h2>
<ul>
  <li><strong><a href="https://digitalesmart.it" target="_blank" rel="noopener">Digitale Smart</a></strong> and <strong><a href="https://tid.swiss" target="_blank" rel="noopener">TID</a></strong> — technology stack.</li>
  <li><strong>Iwona Ciardullo Kos</strong> — legal expertise.</li>
  <li><strong><a href="https://pixabay.com/it/users/magiaz-10236927/?utm_source=link-attribution&amp;utm_medium=referral&amp;utm_campaign=music&amp;utm_content=405761" target="_blank" rel="noopener">Mauricio Póvoa</a></strong> — splash startup sound (via <a href="https://pixabay.com/sound-effects//?utm_source=link-attribution&amp;utm_medium=referral&amp;utm_campaign=music&amp;utm_content=405761" target="_blank" rel="noopener">Pixabay</a>).</li>
</ul>
`;

window.TOS_DOC = { it: TOS_IT, en: TOS_EN };
