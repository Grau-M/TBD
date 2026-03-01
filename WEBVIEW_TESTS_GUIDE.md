# Webview Integration Tests - Testing & Verification Guide

## Overview
This document provides step-by-step instructions on how to test and verify the automated Webview integration tests that were implemented for the TBD Logger Teacher Dashboard.

## Test Coverage Summary

### Test Files Created
1. **`src/test/webview.test.ts`** - 20 comprehensive integration tests
2. **`src/test/webview-ui.test.ts`** - 30 UI and rendering tests

### Total Test Count: 50 tests

**Test Breakdown:**
- Panel creation & initialization: 2 tests
- HTML generation & structure: 1 test
- Message communication: 8 tests
- Data analysis & processing: 5 tests
- Settings management: 4 tests
- Export functionality: 2 tests
- Error handling: 2 tests
- UI interaction & navigation: 15 tests
- Theme management: 2 tests
- Note-taking system: 4 tests
- Deletion records: 1 test
- Responsive design: 1 test

---

## Prerequisites

Before running the tests, ensure you have:

1. **Node.js 16+** installed
2. **VS Code 1.108.1+** installed
3. **Project dependencies installed**: 
   ```bash
   npm install
   ```

---

## Method 1: Run Tests from Command Line

### Option A: Run All Tests

```bash
npm test
```

**What this does:**
- Compiles TypeScript tests
- Compiles the extension
- Runs linting
- Executes all tests using Mocha with vscode-test

### Option B: Run Specific Test File

To run only webview integration tests:
```bash
npm test -- --grep "Webview Integration Tests"
```

To run only UI tests:
```bash
npm test -- --grep "Webview UI & Rendering Tests"
```

### Option C: Run Watch Mode for Development

Open two terminals:

**Terminal 1 - Watch for changes:**
```bash
npm run watch
```

**Terminal 2 - Watch tests:**
```bash
npm run watch-tests
```

Then in a third terminal, run tests:
```bash
npm test
```

---

## Method 2: Run Tests via VS Code Task

### Step 1: Open Command Palette
Press `Ctrl+Shift+P` to open the Command Palette

### Step 2: Run Task
Type: `Tasks: Run Task`

### Step 3: Select Watch Tasks
Choose `watch-tests` to watch both extension and tests during development

### Step 4: Run Tests
In the terminal, run:
```bash
npm test
```

---

## Method 3: Debug Tests in VS Code

### Option A: Debug Specific Test

1. Open the test file you want to debug:
   - `src/test/webview.test.ts` or
   - `src/test/webview-ui.test.ts`

2. Set a breakpoint by clicking in the left margin of the line you want to break at

3. Open the **Run and Debug** panel (`Ctrl+Shift+D`)

4. Click **"Create a launch.json file"** if one doesn't exist

5. Select **"Chrome"** as the environment

6. Run all tests with debugging:
   ```bash
   npm test
   ```

### Option B: Use VS Code Testing Explorer

1. Open VS Code Command Palette (`Ctrl+Shift+P`)
2. Type: `Test: Focus on Test Explorer`
3. Expand test categories to see all 50 tests
4. Click the **Run** button (▶️) next to any test to run it individually
5. Click the **Debug** button (🐛) to debug that test

---

## Understanding Test Results

### Successful Test Run Output

When all tests pass, you'll see:

```
Webview Integration Tests
  ✓ Opens Webview panel with Teacher Dashboard title
  ✓ HTML contains required UI elements for all tabs
  ✓ Extension can send logList message to webview
  ✓ Dashboard analysis generates valid metrics
  ... (and so on)

Webview UI & Rendering Tests
  ✓ Dashboard tab triggers analyzeLogs command
  ✓ Logs tab triggers listLogs command
  ✓ Deletions tab triggers getDeletions command
  ... (and so on)

50 passing (2.5s)
```

### Failed Test Output

If a test fails, you'll see:

```
Webview Integration Tests
  1) Panel Creation and Initialization
     Error: Expected value to be truthy but got falsy
     at Test.<anonymous> (src/test/webview.test.ts:45:15)
```

**How to debug:**
1. Read the error message carefully
2. Go to the line number indicated in the error
3. Set a breakpoint and run in debug mode
4. Inspect variables to understand the failure

---

## Test Descriptions & What They Verify

### Webview Integration Tests (webview.test.ts)

| # | Test Name | Purpose | Pass Criteria |
|---|-----------|---------|---------------|
| 1 | Opens Webview panel | Verifies panel creation | Panel opens without error |
| 2 | HTML contains required elements | Validates HTML structure | All UI elements present |
| 3 | Extension sends logList message | Tests message protocol | Message structure correct |
| 4 | Dashboard analysis generates metrics | Validates data processing | Metrics computed correctly |
| 5 | handleOpenLog sends data | Tests file service | Proper response sent |
| 6 | Settings retrieved with defaults | Validates default settings | All settings have correct defaults |
| 7 | Settings are updated | Verifies settings persistence | Settings saved and retrieved |
| 8 | Export CSV structure | Validates CSV export format | Message structure correct |
| 9 | Export JSON structure | Validates JSON export format | Message structure correct |
| 10 | Generate profile parameters | Validates profile command | Required params present |
| 11 | Generate timeline parameters | Validates timeline command | Required params present |
| 12 | Deletions handler | Tests deletion data processing | Message sent correctly |
| 13 | Load notes message | Validates note loading | Message structure correct |
| 14 | Save notes message | Validates note saving | Message structure correct |
| 15 | Password requirement | Tests security | All sensitive commands protected |
| 16 | Invalid commands handled | Tests error handling | Unknown commands ignored safely |
| 17 | Client ready message | Tests initialization | Message properly formatted |
| 18 | Loading states consistency | Tests UI feedback | All states properly communicated |
| 19 | Response messages structure | Validates message format | All messages have command field |
| 20 | Full message cycle | Tests complete flow | Request→Process→Response works |

### Webview UI Tests (webview-ui.test.ts)

| # | Test Name | Purpose | Pass Criteria |
|---|-----------|---------|---------------|
| 1-4 | Tab Navigation | Tests tab switching | Correct commands sent per tab |
| 5-6 | Search Filtering | Tests log search | Filters applied correctly |
| 7-8 | Theme Toggle | Tests theme switching | Theme persists | 
| 9-10 | Refresh Buttons | Tests refresh commands | Correct messages sent |
| 11 | Log Selection | Tests dropdown selection | openLog message sent |
| 12-13 | Export Actions | Tests export formats | CSV and JSON supported |
| 14-17 | Profile/Timeline Generation | Tests data selection | Minimum selection enforced |
| 18-20 | Settings Form | Tests settings UI | Values load, update, reset |
| 21 | Close Log | Tests log viewer close | Display cleared |
| 22-23 | Status & Error Messages | Tests user feedback | Messages displayed properly |
| 24-29 | Data Rendering | Tests content display | Dashboard, logs, notes rendered |
| 30 | Responsive Design | Tests mobile menu | Hamburger menu works |

---

## Performance Testing

### Measure Test Execution Time

Run tests and observe the timing:

```bash
npm test -- --reporter spec
```

The output will show:
```
50 passing (2.5s)
```

**Acceptable Performance Thresholds:**
- Individual test: < 100ms
- Full test suite: < 5s
- With compilation: < 15s

### Monitor Memory Usage

On Windows, use Task Manager:
1. Run tests: `npm test`
2. Open Task Manager (Ctrl+Shift+Esc)
3. Find node.exe process
4. Monitor Memory column during test execution
5. Acceptable: < 200MB

---

## Coverage Report

### Generate Coverage Report

To generate a coverage report (requires nyc):

```bash
npm install --save-dev nyc
npx nyc npm test
```

This will generate coverage statistics showing:
- Line coverage
- Branch coverage  
- Function coverage
- Statement coverage

### View Coverage Details

Coverage report will be saved to `coverage/index.html`. Open in browser to visualize:
- Which lines are tested
- Which branches are tested
- Coverage percentage per file

---

## Integration with CI/CD

### GitHub Actions Example

Add to `.github/workflows/test.yml`:

```yaml
name: Webview Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      - run: npm install
      - run: npm test
```

### Pre-Commit Hook

Create `.git/hooks/pre-commit`:

```bash
#!/bin/bash
npm test
if [ $? -ne 0 ]; then
  echo "Tests failed. Commit aborted."
  exit 1
fi
```

Make it executable:
```bash
chmod +x .git/hooks/pre-commit
```

---

## Testing Checklist for Manual Verification

### Before Merging PR

- [ ] All 50 automated tests pass
- [ ] No test warnings or deprecations
- [ ] Code coverage > 80%
- [ ] No console errors in test output
- [ ] Tests run < 5 seconds

### Functionality Verification

- [ ] Open Teacher Dashboard without errors
- [ ] All tabs navigate correctly
- [ ] Search filters work in logs tab
- [ ] Settings save and persist
- [ ] Export buttons work (CSV & JSON)
- [ ] Notes can be added and saved
- [ ] Theme toggle works and persists
- [ ] Responsive design works on mobile width

### Edge Cases

- [ ] Dashboard handles empty log lists
- [ ] Search handles special characters
- [ ] Settings handles invalid input
- [ ] Export handles large files
- [ ] Notes handle very long text
- [ ] UI handles rapid tab switching

---

## Common Issues & Solutions

### Issue 1: "Extension not found" Error

**Cause:** Extension not activated  
**Solution:**
```bash
npm run compile
npm test
```

### Issue 2: "Port already in use"

**Cause:** Previous test process still running  
**Solution:**
```bash
# Kill any node processes
taskkill /F /IM node.exe  # Windows
# or
killall node  # Mac/Linux
```

### Issue 3: Tests timeout

**Cause:** Missing async/await or slow operations  
**Solution:**
```typescript
// Increase timeout
test('Long operation', async function() {
    this.timeout(10000);  // 10 seconds
    // test code
});
```

### Issue 4: Inconsistent test results

**Cause:** Tests modifying shared state  
**Solution:** Each test uses `setup()` and `teardown()` to reset state

---

## Continuous Monitoring

### Watch Mode Development

```bash
# Terminal 1: Compile and watch
npm run watch

# Terminal 2: Watch tests
npm run watch-tests

# Terminal 3: Run tests (will re-run as files change)
npm test -- --watch
```

### Test Report Generation

To generate an HTML test report:

```bash
npm install --save-dev mochawesome
npx mocha out/test/**/*.test.js --reporter mochawesome
```

Open `mochawesome-report/mochawesome.html` to view results.

---

## Success Criteria

Your implementation is complete when:

✅ **All 50 tests pass** consistently  
✅ **Tests provide coverage** for all major Webview features  
✅ **Message protocol is validated** with round-trip tests  
✅ **UI interactions are tested** across all tabs and features  
✅ **Data flow is verified** from extension to webview  
✅ **Error handling is confirmed** for edge cases  
✅ **Settings management is tested** for persistence  
✅ **Performance is acceptable** (< 5 seconds total run time)  

---

## Next Steps

1. **Run the test suite:** `npm test`
2. **Review test output:** Check that all 50 tests pass
3. **Create a coverage baseline:** Document current coverage percentage
4. **Set up CI/CD:** Integrate tests into your build pipeline
5. **Add more tests:** Extend coverage for specific use cases

---

## Additional Resources

- [VS Code Extension Testing Guide](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [Mocha Documentation](https://mochajs.org/)
- [VS Code API Reference](https://code.visualstudio.com/api)

---

## Contact & Support

For issues or questions about these tests:
1. Check the test output for specific failures
2. Review the test comments explaining what each test verifies
3. Consult the test descriptions in this guide
4. Enable debug mode and inspect variables in VS Code

---

**Last Updated:** 2024
**Maintainer:** Development Team
**Version:** 1.0
