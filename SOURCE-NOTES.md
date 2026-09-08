# Prototype recovery and scope

Input: `estateos_v1_prototype (13).zip`, supplied by the user. Contains README.md, index.html, empty app.js and debug_chunk.txt. The actual application script is embedded in index.html. The prototype remains preserved in the task's intermediate workspace.

Verified references:

| Residence | Family | Location |
|---|---|---|
| Palm Beach Residence | Whitmore Family | Palm Beach, FL |
| Oceanfront Residence | Carter Family | Jupiter Island, FL |
| River Estate | Harrison Family | Stuart, FL |
| Lake House | Morgan Family | Lake Placid, FL |
| City Residence | Santos Family | Miami, FL |
| Seasonal Condo | Whitmore Family | Naples, FL |

These source fixtures are not automatically added as real customer data.

Confirmed source defects: `getShoppingForResidence` references undefined `shoppingLists` instead of `propertyShopping`, causing the client residence flow to fail. Vendor completion assigns activity to `demoClient`, which can differ from the residence's owner. New property/vendor/asset state is not consistently saved, maintenance creation can show a success alert without storing a plan, and some document controls are placeholders. Initial suspicion of duplicated rendering code was disproved on closer inspection.

The working application uses a server database, stable record IDs, authenticated access checks and foreign-key relationships instead of preserving those mechanisms. Demo role selection, browser-local business storage and CDN-dependent PDF generation are not used.
