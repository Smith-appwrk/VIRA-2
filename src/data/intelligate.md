# IntelliGate FAQ Knowledge Base

## Driver Questions

### QR Code Issues

- **Issue**: QR code not getting scanned
- **Solution**:
  - Avoid using any QR scanning app
  - Hold mobile camera steady in front of QR code until a link popup appears
  - Try using Google Lens as an alternative (access via Google.com camera icon)

### How to scan QR code?

- Look for google bar on phone and click on google lens
- Hold camera steady in front of QR code until a link popup appears
- Application will be opened

### Getting a blank screen after licence Scan

- Please follow the steps on 'how to scan the QR code?'
- If still facing an issue, it might be due to network coverage
- Check with gate agent who can help with your registration

### Registration Options

#### Coming In Options

- **Empty**: Select if coming with an empty trailer
- **Loaded**: Select if coming with a delivery load
- **Bobtail**: Select if not coming with any trailer

#### Going Out Options

- **Empty**: Select if taking an empty trailer while leaving
- **Loaded**: Select if picking up a load
- **Bobtail**: Select if not taking out any trailer

#### Carrier Company Selection

- For delivering a load: Enter company name from inbound BOL
- For dropping empty trailer: Select company name the trailer belongs to
- For taking out empty trailer: Not needed if you know preferred trailer number
- If carrier not found: Type a few letters to search, or contact Gate agent

### Common Issues

#### Cannot find carrier name

- Search by typing a few letters
- Contact Gate agent if not found

#### Finding pickup number

- Check with your carrier company for pickup/outbound load number

#### Finding inbound load number

- Check BOL document (number typically starts with 019)
- You can also enter shipment number starting with 034
- Contact Gate agent if unable to find

#### Getting shipment number not valid error

- Recheck if the site selected is correct
- Check if scenario selection is correct
- If still getting invalid value, reach out to Gate Agent

#### Getting 'Can not allow early check in' error

- You will see details of what time the appointment is scheduled
- You will not be able to register until the time mentioned in the message

#### Getting Preferred trailer not valid error

- Recheck the trailer number entered
- It means there is no trailer present in the yard with the provided preferred trailer

#### Getting no Empty Trailer number available

- It means that there are no empty trailers available for the carrier company to take out

#### License validation issues

- Check license validity
- Contact gate agent for further instructions

#### How to scan driver's Licence?

- Allow the camera access to browser
- Scan the front side of licence
- Scan the back side of licence
- Allow some time to get the licence scanned
- Once completed, your details will be populated

#### Timeout during license scan

- It might be due to network issue
- Select 'unable to scan' to enter details manually
- Reach out to Gate Agent for bypass code

#### OTP not received

- Check mobile network signal
- Verify mobile number is correct
- Try 'Resend Code'
- Check with validators for passcode

#### Employee ID requirement

- System asks for Employee ID and last 4 digits of license for fast pass process
- Get credentials from carrier company
- Click 'skip login' to proceed with license scan process
- If you have tablet mounted on your truck, you will receive OTP on your tablet

## Validator Questions

### Driver Registration Issues

- If driver cannot scan license:
  - Ask driver to click 'unable to Scan' and provide site Passcode
- If driver cannot scan QR code:
  - Ask driver to use Google Lens
  - Help driver register from your tab if needed

### How to check the site selected by Driver

- Check on right side top corner for the site selected
- Ask the driver to go back and change site if wrong site is selected

### Application Issues

#### App not responding

1. Go to home page and find IntelliGate Application icon
2. Long press on IntelliGate application icon
3. Click on ⓘ button
4. Click force stop
5. Reopen the application
6. If issues persist, restart tablet or contact UL IT support

#### Blank screen

1. Long press on IntelliGate application icon
2. Click on ⓘ button
3. Scroll to "storage"
4. Click "clear cache"
5. Click "clear data" → "delete"
6. Return to home page and reopen app

### Communication Issues

- If drivers aren't receiving texts:
  - Check sent messages tab
  - Communicate details directly
- For ad hoc messages:
  - Use active driver screen
  - Click 'Send Message' for specific driver

### Driver Process Issues

#### Overweight trailer return

- Ask driver to register as "empty to empty live"
- Confirm which door to proceed to for rework

#### Driver is overweight but not checked out yet

- Check with workflow team to send the driver for rework
- Ask the driver to go to that door
- Search the O/B trailer number in yard check & update yard location
- Send ad hoc message to the driver if needed

#### Incorrect preferred trailer

- Check if driver registered with preferred trailer option
- Verify trailer is in Yard (not at 'ANYWHERE' location)
- Edit driver in active driver screen to update outbound trailer number
- For SCAC option issues:
  - Check if trailer SCAC matches driver's registered SCAC
  - Update outbound SCAC if different

### Information Lookup

- Find driver history:
  - Click on driver number column hyperlink or use 'driver history' page
- Find trailer history:
  - Go to 'trailer activity' page and filter by trailer number

### How to update the user?

1. Go to control panel --> Users new
2. Search with the username
3. Click on Edit (Pencil Symbol)
4. Make the updates and save

## Check In Issues

### "Error missing argument: new Yard Loc"

- Location not assigned to driver
- Check with IG support team

### "ERROR NO TEXT FOUND"

- Error in BY system
- Check with IG support team

### "UC_PRC_SELF_DRIVER_CHECK_IN"

- Missing driver attributes:
  - For empty: I/B trailer number and I/B SCAC required
  - For loaded: I/B trailer number, I/B SCAC and I/B load numbers required
  - Edit and add missing attributes

### "504 timeout error"

- Connection issue between IntelliGate and WMS
- Raise issue with UL IT team

### "Can not change transport equipment once loading has started error"

- Driver is trying to register for a live appointment, but workflow team has already loaded or started loading on a different trailer
- Connect with workflow team to check on next steps

### Trailer Status is empty in IG but loaded in BY

- Get confirmation from yard jockey regarding the status of the trailer
- If trailer is loaded, identify the load attached to it
- Ask workflow team to attach the load to the trailer
- If issues persist, connect with UL IT support team

## Check Out Issues

### "Different tractor or Trailer number was registered at the time of Check in"

1. Check the trailer number and tractor number in active driver
2. Search the driver in driver history and check if details were updated after check-in
3. If yes, change the tractor number in active driver
4. Search the trailer in trailer activity to check if it is dispatched
5. If the trailer is dispatched from BY, connect with UL IT team to revert the dispatch

### "Trailer number not matching with Seal number"

1. Physically check seal on trailer
2. Go to Yard check page, search trailer number
3. Update correct seal in yard check page
4. Proceed with Check-out

### "The inventory's status is not a valid status for the outbound order's progression"

- Inventory for load is on hold
- Check with workflow team regarding inventory status
- Proceed after confirmation from workflow team

### "Invalid Equipment Status"

- Trailer status in BY is different than expected
- Check with workflow team
- Proceed after confirmation

### "Trailer you are trying to pick up does not contain outbound load XXXX"

- Mismatch between trailer load and registered O/B load
- Check O/B load in active driver screen
- Confirm correct load number and update

### "Carrier code for load does not match with carrier code for transport equipment"

- Connect with customer support to correct carrier with correct SCAC
- Update load number, I/B & O/B SCACs in active driver

### "UC_TRLR_DISP_SELF_DRVR error"

- This is a system MOCA error
- Check with UL IT team

## Work Queue Team

### Marking trailer as damaged

1. Go to Yard check
2. Filter by trailer number
3. Click on Edit (Pencil Icon)
4. Update Trailer Condition
5. Provide reason and save

### Common Issues

- Trailer and truck incorrect
- Incorrect scenario selected by driver
- Wrong reference selected
- Rename incorrect trailer number from yard check
- Active move on trailer - ask spotter or work queue to complete move
- Trailer is at door - reach out to work queue to move trailer to yard
- Empty trailer not available - change the scenario
- Trailer note not captured when marking trailer as damaged
- Want to reserve Empty during check in - add in trailer note
- Appointment type incorrect live/drop - reach out to customer service
- Driver entered incorrect trailer number for checkout
- Driver entered outgoing trailer different from system assigned trailer
- Driver selected incorrect outgoing scenario
- Create immediate move for spotters
- Communicating with spotter for completing yard move

## Spotter Questions

### Unauthorized error/frozen screen

1. Close app using 'Home' button
2. Long press on SDC app logo
3. Click ⓘ button
4. Click Force Stop
5. Reopen and login

### Yard audit process

- Go to Yard Check
- Filter with starting letters of yard (e.g., DDN for locations DDN01-DDN49)
- Update location/trailer if discrepancies found

### Trailer present but not in system

- Inform welcome centre team
- They will create the trailer in the system

### Trailer present physically at location not matching with system

1. Open Yard Check
2. Look for the location
3. Click on update
4. Click on "Update Other Attributes"
5. Click on Swap Trailer
6. Provide the trailer number which is physically present at the location

# Dynamic Response Templates

Q: What is the status of load <number>?
A: This load is <percentage>% loaded, it will take another <hours> hours to complete Loading, Thank you for your patience.

Q: When is appointment for this load <number>?
A: It is scheduled for <date> <time>.

Q: Can you change appointment to now?
A: Sure, i can do that, please enter secret pin to change appointment time.

Q. I don't have any pin
A. Ok You are not Authorized to make changes, please talk to gate agent for assistnace.

Q. PIN is <1001>
A. This is not a valid PIN.

Q. ok try this, 1002
A. Success, Appointment for your load is updated!!

Q. is ANSH a valid SCAC?
A. Yes ANSH stands for Alliance Carrier Company, it is valid in my knowledge base.

Q. what about XXXX
A. Sorry, XXXX is not a valid scac.

Q: How many appointments are left for today?
A: We had <total> appointments scheduled for today. Out of which <pending> are still pending.

Q: How many out of service trailers do we have?
A: We have total <count> OOS trailers sitting in our yard.
Details:

- <trailer_number> Arrived At: <date>
- <trailer_number> Arrived At: <date>

---

Q. send me email of all empty trailer
A. Currently i am not configured to send email alerts.

---

Q. How many empty trailer we have for PMDT
A. Currently we have 3 PMDT trailers in our yard.

---

Q. Do we have any empty trailer for SHAF to give to driver.
A. We have 2 empty trailer for SHAF but we need them to fulfill outbound loads.

---

Q. What is total detention charges build last month
A. As per my calculation in the month of March 2025, we incurred <1230> USD in detention cost.

---

Q. Who is the highest contributor
A. ANSH drivers contributed most in building detention charges.

---

Q: What's the demurrage cost for trailer <number>?
A: Total calculated charges <amount> USD.
Calculation breakdown:

- <range1> days: Free
- <range2> days: <amount1> USD Per day
  - <range3> days: <amount2> USD Per day

Total days in Yard: <days> days

Q: What's the total detention cost incurred during the month of <march 2025>?
A: Total detention cost incurred during the month was <1500 USD>.

Q: Can you show the breakdown of detention cost by each carrier?
A: Sure, here is the cost charged by each carrier in the month of <march 2025>.
<Papers Transportation - 740 USD>
<Clipper Logistics - 260 USD>
<Shaffer Trucking Company - 120 USD>

<Legend Transport - 380 USD>
Total Charges <1500 USD>.

Q: What is the demurrage charges incurred in the year 2024?
A: Demurrage charges : <8000 USD>.

Q: How many appointments are planned for today?
A: We have 2 Inbound and 1 Outbound load appointment pending for the day.

Q: Can you give me details about those loads?
A: Sure, here are the details.
<Inbound> loads:
<trailer_number> expected at <date - format - hour AM/PM today/tomorrow>.
<trailer_number> expected at <date - format - hour AM/PM today/tomorrow>.

<Outbound> loads:
<trailer_number> expected at <date - format - hour AM/PM today/tomorrow>.
