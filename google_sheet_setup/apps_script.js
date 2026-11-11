/**
 * Ocean County Roofing Pros - Auto Formatting & Status Triggers
 * Paste into: Extensions > Apps Script in your Google Sheet.
 */

function onEdit(e) {
  var sheet = e.source.getActiveSheet();
  var sheetName = sheet.getName();

  if (sheetName !== "Leads_Inbox") return;

  var range = e.range;
  var row = range.getRow();
  if (row === 1) return; // Skip headers

  var statusCol = 12; // Column L: status
  var urgencyCol = 11; // Column K: urgency

  var statusVal = sheet.getRange(row, statusCol).getValue();
  var urgencyVal = sheet.getRange(row, urgencyCol).getValue();
  var rowRange = sheet.getRange(row, 1, 1, 17);

  // Soft color formatting
  if (urgencyVal === "Emergency") {
    rowRange.setBackground("#fee2e2"); // Soft red for active emergencies
  } else if (statusVal === "New Lead") {
    rowRange.setBackground("#fef9c3"); // Soft yellow for new uncontacted leads
  } else if (statusVal === "Inspection Scheduled" || statusVal === "Contract Signed") {
    rowRange.setBackground("#dcfce7"); // Soft green for booked deals
  } else {
    rowRange.setBackground("#ffffff");
  }
}
