# Runway reference values (free-form runway model)

**Status: reference values, not a guarantee of compliance.** Values were transcribed from the freely available documents listed in the Sources section and converted to metres where needed (1 ft = 0.3048 m; the FAA text itself uses 0.305 m). Access date for all sources: 2026-11-11. Anything not located in the sources is marked NOT FOUND.

## Sources

| ID | Document | Edition / date | URL | Used for |
|---|---|---|---|---|
| FAA-AC | FAA AC 150/5300-13B *Airport Design*, consolidated with Change 1 (errata 2025-04-03 also published) | 31 Mar 2022, Chg 1 16 Aug 2024 | https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC-150-5300-13B-Airport-Design-Chg1-w-errata.pdf | Runway widths, shoulders, RSA, holding position, taxiway separation (Appendix G, Tables G-1 to G-12; para 3.9, 3.7.3) |
| FAA-AIM | FAA Aeronautical Information Manual, Ch. 2 Sec. 3 *Airport Marking Aids and Signs*, para 2-3-3 *Runway Markings* ('Runway Designators') | current online edition | https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap2_section_3.html | Runway designator definition, L/C/R suffixes |
| EASA-DSN | EASA *CS-ADR-DSN* (Certification Specifications for Aerodrome Design), Issue 5, Annex to ED Decision 2021/004/R | Issue 5, 16 Jun 2025 | https://www.easa.europa.eu/en/downloads/125398/en | ICAO-code-number based values: runway width (B.045), shoulders (B.125/B.135), strip (B.155/B.160), RESA (C.210/C.215), parallel runways (B.050/B.055), taxiway separation (D.260, Table D-1), holding positions (D.340, Table D-2), runway designation marking (L.525) |
| NOAA-WMM | NOAA NCEI World Magnetic Model calculator (cited only, not used for values) | current | https://www.ncei.noaa.gov/products/world-magnetic-model | Magnetic declination (manual input) |

Not fetched / not used: ICAO Annex 14 Vol I (paywalled, not used); UK CAA CAP 168; Transport Canada TP 312 (search snippets only: a 150 m minimum RESA length was mentioned in a search summary, not verified against the PDF); Japanese MLIT standards (not searched).

## 1. Runway designation

| Item | Value | Source |
|---|---|---|
| Number | Whole number nearest one-tenth of the magnetic azimuth of the runway centreline, measured clockwise from magnetic north | FAA-AIM 2-3-3 'Runway Designators'; EASA-DSN L.525(c)(1)(i) |
| Single digit | Preceded by zero (e.g. 05, 09) | EASA-DSN L.525(c)(1)(iii) |
| 0 vs 36 (wrap at 360 degrees) | Not stated explicitly in the fetched sources; only the nearest-tenth rule is given | NOT FOUND explicitly |
| Rounding of exact .5 | Not stated in fetched sources ('nearest') | NOT FOUND |
| Two parallel runways | L and R, ordered left to right when viewed from the approach direction | FAA-AIM 2-3-3; EASA-DSN L.525(c)(1)(ii) |
| Three parallel runways | L, C, R | FAA-AIM 2-3-3; EASA-DSN L.525(c)(1)(ii) |
| Four parallel runways | L, R, L, R (EASA numbering rule: one adjacent pair to nearest tenth, the other pair to the next nearest tenth) | EASA-DSN L.525(c)(1)(ii) and (iv) |
| Five parallel runways | L C R L R or L R L C R | EASA-DSN L.525 (2)(iv) |
| Six parallel runways | L C R L C R | EASA-DSN L.525 (2)(v) |
| Reciprocal differs by 18 | Arithmetic consequence of the definition (add or subtract 18 from the number, modulo 36). Not quoted from any fetched source | derived |
| Magnetic variation | Use an official declination source (NOAA WMM calculator) and enter the value manually | NOAA-WMM (cited, not fetched for values) |

## 2. Runway width

### 2a. FAA (ADG / RDC, Appendix G, Visual column)

FAA width is by Runway Design Code (AAC + ADG). The values below are the 'Visual' column of each table. Footnote 12 (MTOW above 150,000 lb: 150 ft width, 25 ft shoulder, 200 ft blast pad) and footnote 14 (ADG VI, four-or-more-engine aircraft: 50 ft paved shoulders) apply to specific aircraft; those cases are noted, not applied.

### 2b. ICAO (EASA CS-ADR-DSN Table B-1, code number and OMGWS)

| Code number | OMGWS < 4.5 m | 4.5 to < 6 m | 6 to < 9 m | 9 to < 15 m |
|---|---|---|---|---|
| 1 | 18 m | 18 m | 23 m | - |
| 2 | 23 m | 23 m | 30 m | - |
| 3 | 30 m | 30 m | 30 m | 45 m |
| 4 | - | - | 45 m | 45 m |

Note: the EASA table is keyed by code number and OMGWS, not by ICAO code letter. A code-letter width table (e.g. 60 m for code letter F) was NOT FOUND in the fetched free sources. Precision approach runway width is at least 30 m for code 1 or 2 (footnote a).

## 3. Runway shoulders

| Standard | Value | Source |
|---|---|---|
| FAA shoulder width | See Section 4 table (column 'Shoulder'): 10 ft for ADG I-II, 20 ft ADG III, 25 ft ADG IV, 35 ft ADG V-VI (50 ft for ADG VI four+ engine per footnote 14) | FAA-AC Appendix G |
| ICAO total width incl. shoulders, code letter D or E (OMGWS 9 to < 15 m) | 60 m | EASA-DSN CS B.135(a) |
| ICAO total width incl. shoulders, code letter F, two or three engines | 60 m | EASA-DSN CS B.135(b) |
| ICAO total width incl. shoulders, code letter F, four or more engines | 75 m | EASA-DSN CS B.135(c) |
| Shoulder strength | Portion within 30 m of runway centreline should support aircraft and vehicles | EASA-DSN CS B.140 |

Shoulders are required for code letter D, E, F with OMGWS 9 to < 15 m (EASA-DSN CS B.125(b)).

## 4. Runway safety area (FAA RSA) and strip / RESA (ICAO)

### 4a. FAA RSA (AC 150/5300-13B Appendix G, Visual column)

Length beyond departure end: footnote 9 (starts at runway end, or stopway end if a stopway exists). Footnote 10: may be reduced to the EMAS set-back. Length prior to threshold, footnote 11: 600 ft applies only if the runway end has electronic or visual vertical guidance (otherwise use the departure-end value). Footnote 13 (marked on the C/D/E RSA width rows): an RSA width of 400 ft is permissible when 500 ft is not practical.

| Table | RDC | Runway width | Shoulder | RSA length beyond departure end | RSA length prior to threshold | RSA width | Holding position from runway centreline | Parallel taxiway/taxilane centreline from runway centreline |
|---|---|---|---|---|---|---|---|---|
| G-1 | A/B-I Small (ADG I) | 60 ft (18.3 m) | 10 ft (3.0 m) | 240 ft (73.2 m) | 240 ft (73.2 m) | 120 ft (36.6 m) | 125 ft (38.1 m) | 150 ft (45.7 m) |
| G-2 | A/B-I (ADG I) | 60 ft (18.3 m) | 10 ft (3.0 m) | 240 ft (73.2 m) | 240 ft (73.2 m) | 120 ft (36.6 m) | 200 ft (61.0 m) | 225 ft (68.6 m) |
| G-3 | A/B-II Small (ADG II) | 75 ft (22.9 m) | 10 ft (3.0 m) | 300 ft (91.4 m) | 300 ft (91.4 m) | 150 ft (45.7 m) | 125 ft (38.1 m) | 240 ft (73.2 m) |
| G-4 | A/B-II (ADG II) | 75 ft (22.9 m) | 10 ft (3.0 m) | 300 ft (91.4 m) | 300 ft (91.4 m) | 150 ft (45.7 m) | 200 ft (61.0 m) | 240 ft (73.2 m) |
| G-5 | A/B-III (ADG III) | 100 ft (30.5 m) | 20 ft (6.1 m) | 600 ft (182.9 m) | 600 ft (182.9 m) | 300 ft (91.4 m) | 200 ft (61.0 m) | 300 ft (91.4 m) |
| G-6 | A/B-IV (ADG IV) | 150 ft (45.7 m) | 25 ft (7.6 m) | 1,000 ft (304.8 m) | 600 ft (182.9 m) | 500 ft (152.4 m) | 250 ft (76.2 m) | 400 ft (121.9 m) |
| G-7 | C/D/E-I (ADG I) | 100 ft (30.5 m) | 10 ft (3.0 m) | 1,000 ft (304.8 m) | 600 ft (182.9 m) | 500 ft (152.4 m) | 250 ft (76.2 m) | 300 ft (91.4 m) |
| G-8 | C/D/E-II (ADG II) | 100 ft (30.5 m) | 10 ft (3.0 m) | 1,000 ft (304.8 m) | 600 ft (182.9 m) | 500 ft (152.4 m) | 250 ft (76.2 m) | 300 ft (91.4 m) |
| G-9 | C/D/E-III (ADG III) | 100 ft (30.5 m) | 20 ft (6.1 m) | 1,000 ft (304.8 m) | 600 ft (182.9 m) | 500 ft (152.4 m) | 250 ft (76.2 m) | 400 ft (121.9 m) |
| G-10 | C/D/E-IV (ADG IV) | 150 ft (45.7 m) | 25 ft (7.6 m) | 1,000 ft (304.8 m) | 600 ft (182.9 m) | 500 ft (152.4 m) | 250 ft (76.2 m) | 400 ft (121.9 m) |
| G-11 | C/D/E-V (ADG V) | 150 ft (45.7 m) | 35 ft (10.7 m) | 1,000 ft (304.8 m) | 600 ft (182.9 m) | 500 ft (152.4 m) | 250 ft (76.2 m) | 400-500 |
| G-12 | C/D/E-VI (ADG VI) | 150 ft (45.7 m) | 35 ft (10.7 m) | 1,000 ft (304.8 m) | 600 ft (182.9 m) | 500 ft (152.4 m) | 280 ft (85.3 m) | 500 ft (152.4 m) |

Note: 'Visual' RDC columns are used. Non-visual approach columns in Appendix G have different holding position and RPZ values; see the AC.

### 4b. ICAO strip and RESA (EASA CS-ADR-DSN, ICAO code number)

| Item | Code 1 | Code 2 | Code 3 | Code 4 | Source |
|---|---|---|---|---|---|
| Strip length beyond runway/stopway end | 60 m (instrument) / 30 m (non-instrument) | 60 m | 60 m | 60 m | CS B.155 |
| Strip half-width, precision approach runway (each side of centreline) | 70 m | 70 m | 140 m | 140 m | CS B.160(a) |
| Strip half-width, non-precision approach runway | 70 m | 70 m | 140 m | 140 m | CS B.160(b) |
| Strip half-width, non-instrument runway | 30 m | 40 m | 75 m | 75 m | CS B.160(c) |
| RESA required? | Instrument runway: yes; non-instrument: where practicable | yes (instrument: yes; non-instrument: where practicable) | yes | yes | CS C.210(b),(c) |
| RESA length beyond strip end | Instrument: at least 90 m, as far as practicable 120 m; non-instrument: as far as practicable 30 m | Instrument: at least 90 m, as far as practicable 120 m; non-instrument: as far as practicable 30 m | at least 90 m, as far as practicable 240 m | at least 90 m, as far as practicable 240 m | CS C.215(a) |
| RESA width | at least twice the runway width; wherever practicable equal to the graded strip width | same | same | same | CS C.215(c) |
| Length reduction with arresting system | Permitted, per system design specification | same | same | same | CS C.215(b) |

## 5. RESA / FAA RSA summary

| Item | Value | Source |
|---|---|---|
| ICAO RESA minimum length beyond strip end | 90 m (code 3-4 and code 1-2 instrument, and where the strip is required); 240 m / 120 m 'as far as practicable' | EASA-DSN CS C.215(a) |
| ICAO RESA width | At least twice runway width; equal to graded strip width where practicable | EASA-DSN CS C.215(c) |
| FAA RSA length beyond departure end | ADG I: 240 ft (73.2 m); ADG II: 300 ft (91.4 m); ADG III: 600 ft (182.9 m) for A/B-III, 1,000 ft (304.8 m) for C/D/E-III; ADG IV-VI: 1,000 ft (304.8 m) (A/B-IV and C/D/E rows) | FAA-AC Appendix G (see Section 4a) |
| FAA RSA width | 120 ft (36.6 m) ADG I, 150 ft (45.7 m) ADG II, 300 ft (91.4 m) ADG III, 500 ft (152.4 m) ADG IV-VI | FAA-AC Appendix G (see Section 4a) |

## 6. Parallel runway centreline separation

| Operation | FAA value | ICAO / EASA value | Source |
|---|---|---|---|
| VFR simultaneous independent landings and takeoffs | 700 ft (213 m) at towered or non-towered airport | - | FAA-AC 3.9.2 |
| VFR dependent landings and takeoffs, with operating tower | 300 ft (91 m) | - | FAA-AC 3.9.2 |
| IFR simultaneous approaches, high update surveillance (ADS-B), straight-in | 3,200 ft (975 m); 2,500 ft (762 m) with offset approach | Independent parallel approaches: 1,035 m; dependent: 915 m | FAA-AC 3.9.3; EASA-DSN B.055 |
| IFR simultaneous approaches, no high update surveillance | 3,100 ft (945 m) | see above | FAA-AC 3.9.3 |
| Triple simultaneous approaches | 3,100 ft (945 m); 2,500 ft (762 m) with offset to outboard runway | - | FAA-AC 3.9.3 |
| Simultaneous departures | 2,500 ft (762 m) with diverging courses (10 deg RNAV / 15 deg non-RNAV); less than 2,500 ft requires 15 deg | Independent parallel departures: 760 m; segregated: 760 m | FAA-AC 3.9.4; EASA-DSN B.055 |
| Non-radar departures | 3,500 ft (1,067 m) with 45 deg divergence | - | FAA-AC 3.9.4 |
| Mixed departure / approach, unstaggered | 2,500 ft (762 m) | - | FAA-AC 3.9.4 |
| Recommended minimum, ADG V and VI | 1,200 ft (366 m) | - | FAA-AC 3.9.4 (recommended practice) |
| ICAO non-instrument parallel runways (simultaneous use) | - | code 1: 120 m; code 2: 150 m; code 3-4: 210 m | EASA-DSN B.050 |

Converted (1 ft = 0.3048 m): 3,200 ft = 975.4 m; 3,100 ft = 944.9 m; 2,500 ft = 762.0 m; 1,200 ft = 365.8 m; 3,500 ft = 1,066.8 m; 700 ft = 213.4 m; 300 ft = 91.4 m.

## 7. Runway to taxiway and holding position separation

### 7a. FAA (Appendix G, Visual column)

Holding position distance is from the runway centreline. Parallel taxiway/taxilane centreline distance (row D) is from the runway centreline. Footnote 2 says the standard is for airports at sea level; increase for higher elevations. Footnote 8 adds 1 ft per 100 ft above sea level for some rows. See the 4a table above for the per-RDC values.

### 7b. ICAO (EASA-DSN)

| Code letter | Taxiway centreline to runway centreline, instrument code 1 / 2 / 3 / 4 | Non-instrument code 1 / 2 / 3 / 4 | Taxiway centreline to taxiway centreline | Source |
|---|---|---|---|---|
| A | 77.5 / 77.5 / - / - | 37.5 / 47.5 / - / - | 23 m | EASA-DSN D.260 Table D-1 |
| B | 82 / 82 / 152 / - | 42 / 52 / 87 / - | 32 m | same |
| C | 88 / 88 / 158 / 158 | 48 / 58 / 93 / 93 | 44 m | same |
| D | - / - / 166 / 166 | - / - / 101 / 101 | 63 m | same |
| E | - / - / 172.5 / 172.5 | - / - / 107.5 / 107.5 | 76 m | same |
| F | - / - / 180 / 180 | - / - / 115 / 115 | 91 m | same |

EASA Table D-1 values are the ordinary combination distances, in metres, with code number columns for runway and code letter for the taxiway.

Holding position distance from runway centreline (EASA-DSN D.340, Table D-2, metres):

| Runway type | Code 1 | Code 2 | Code 3 | Code 4 |
|---|---|---|---|---|
| Non-instrument | 30 | 40 | 75 | 75 |
| Non-precision approach | 40 | 40 | 75 | 75 |
| Precision approach Category I | 60 | 60 | 90 | 90 (107.5 where code letter F) |
| Precision approach Category II/III | - | - | 90 | 90 (107.5 where code letter F) |
| Take-off runway | 30 | 40 | 75 | 75 |

Table D-2 elevation note: above 700 m the code 4 precision 90 m distance increases (1 m per 100 m to 2,000 m elevation).

## 8. Not found

- ICAO code-letter width table (for example 60 m for code letter F): NOT FOUND in the fetched free sources (EASA gives code-number widths only).
- ICAO runway strip length and width for code letter F, and any ICAO shoulder value beyond the EASA B.135 total width: not fetched.
- Rounding of exact .5 magnetic headings in designation, and the 36 vs 0 rule text: NOT FOUND in the fetched sources.
- FAA JO 7400.2 and FAA JO 7110.65 designation text: not fetched.
- Transport Canada TP 312 and UK CAP 168 values: not fetched (search snippets only).
- Japanese MLIT 空港土木施設設置基準: not searched.

## Caveats

- These are reference values for a free-form game model, not a guarantee of compliance with any standard.
- FAA values are Visual-approach columns from Appendix G; instrument-approach columns differ.
- EASA CS-ADR-DSN is EASA's civil aerodrome specification; values are cited from it and were not checked line-by-line against ICAO Annex 14.
