# Leadership terms

Terms as the leadership team uses them. Where an entry names a saved search,
that search is the agreed definition: run it with `ns_runSavedSearch` rather
than writing SuiteQL, even if a query looks equivalent.

### Franchise locations
- Means: open franchise locations, as defined by Leadership.
- Source: saved search `customsearch9695` (Leadership- Open Franchise Locations).
- Columns: Store ID, Name, Owning Franchise Group, FBC, City/State, Phone
  Number, Store Status, Region, Store Open Date, Store Address. Use these for
  breakdowns by region, state, franchise group, FBC, or open date.
- Answer: the row count. Run with range_start 0 and range_end 1000; if exactly
  1000 rows come back, fetch the next range before counting. Say "open
  franchise locations" so the user knows which definition was used.
- Also asked as: franchise sites, franchise washes, franchisee locations,
  franchise stores
