# Webview Tests - Quick Start Guide

## 🚀 Run Tests Immediately

```bash
npm test
```

That's it! This will:
1. ✅ Compile the TypeScript code
2. ✅ Compile the tests
3. ✅ Run linting
4. ✅ Execute all 50 webview tests

---

## 📊 Expected Output

When tests pass, you'll see:

```
Webview Integration Tests
  ✓ Opens Webview panel with Teacher Dashboard title
  ✓ HTML contains required UI elements for all tabs
  ✓ Extension can send logList message to webview
  ✓ Dashboard analysis generates valid metrics
  ✓ handleOpenLog sends logData or rawData message
  ✓ Settings are retrieved with default values
  ✓ Settings are updated and persisted
  ... (20 tests total)

Webview UI & Rendering Tests
  ✓ Dashboard tab triggers analyzeLogs command
  ✓ Logs tab triggers listLogs command
  ✓ Deletions tab triggers getDeletions command
  ✓ Settings tab only switches view without data request
  ✓ Search input filters log names correctly
  ... (30 tests total)

50 passing (2.5s)
```

---

## 📁 Test Files Location

- **Integration Tests:** `src/test/webview.test.ts`
- **UI Tests:** `src/test/webview-ui.test.ts`

---

## 🔍 View Specific Tests

### Run only integration tests
```bash
npm test -- --grep "Webview Integration Tests"
```

### Run only UI tests
```bash
npm test -- --grep "Webview UI & Rendering Tests"
```

### Run tests matching a pattern
```bash
npm test -- --grep "Settings"
```

---

## 🐛 Debug Mode

### Option 1: Debug in VS Code
1. Open `src/test/webview.test.ts`
2. Click on line numbers to set breakpoints
3. Press `F5` or `Ctrl+Shift+D` to open Debug panel
4. Run: `npm test`

### Option 2: Chrome DevTools
```bash
npm test -- --inspect-brk
```
Then open chrome://inspect

---

## 👀 Watch Mode (for development)

```bash
# Terminal 1: Watch for code changes
npm run watch

# Terminal 2: Watch for test changes
npm run watch-tests

# Terminal 3: Run tests
npm test
```

Tests will automatically re-run as you make changes.

---

## ✅ What Gets Tested

### Webview Integration (20 tests)
- ✓ Panel creation and initialization
- ✓ HTML generation with all UI elements
- ✓ Message communication between extension and webview
- ✓ Dashboard data analysis
- ✓ File service operations
- ✓ Settings management
- ✓ Export functionality (CSV/JSON)
- ✓ Profile & timeline generation
- ✓ Deletion data handling
- ✓ Note-taking system
- ✓ Security & password enforcement
- ✓ Error handling
- ✓ Message protocol validation

### UI & Rendering (30 tests)
- ✓ Tab navigation
- ✓ Search and filtering
- ✓ Theme switching and persistence
- ✓ Refresh buttons
- ✓ Log selection and viewing
- ✓ Settings form (load, update, reset)
- ✓ Status messages
- ✓ Error messages
- ✓ Dashboard rendering
- ✓ Log viewer display
- ✓ Note-taking UI
- ✓ Deletion records display
- ✓ Responsive design (mobile menu)

---

## 📋 Troubleshooting

### Issue: "Port already in use"
```bash
# Kill node processes
taskkill /F /IM node.exe  # Windows
# or
killall node  # Mac/Linux
```

### Issue: "Extension not found"
```bash
npm run compile
npm test
```

### Issue: Tests timeout
- Tests have been configured with appropriate timeouts
- Most tests complete in < 100ms
- Full suite runs in < 5 seconds

---

## 📊 Test Execution Flow

```
npm test
   ↓
Compile TypeScript → (out/ folder)
   ↓
Compile Tests → (out/test/ folder)
   ↓
Run ESLint → (check code quality)
   ↓
Execute Tests → (Mocha test runner)
   ↓
Display Results → (Pass/Fail summary)
```

---

## 🎯 Pass/Fail Criteria

### ✅ Tests PASS when:
- All assertions evaluate to true
- No exceptions are thrown
- Messages are sent/received correctly
- UI state changes as expected
- Settings persist correctly

### ❌ Tests FAIL when:
- An assertion evaluates to false
- An exception is thrown
- Timeout is exceeded (default: 2 seconds)
- Expected property is undefined
- Received unexpected value

---

## 📈 Coverage

The test suite covers:
- **UI Interactions:** All tabs, buttons, and inputs
- **Data Flow:** Extension → Webview → Client
- **Business Logic:** Dashboard analysis, settings, export
- **Error Cases:** Invalid inputs, missing files
- **Security:** Password enforcement, command validation

---

## 🔗 Related Documentation

- Full guide: [WEBVIEW_TESTS_GUIDE.md](WEBVIEW_TESTS_GUIDE.md)
- Test implementation: [src/test/webview.test.ts](src/test/webview.test.ts)
- UI tests: [src/test/webview-ui.test.ts](src/test/webview-ui.test.ts)

---

## 💡 Pro Tips

1. **Run watch mode during development** - Tests run automatically on save
2. **Use grep to filter tests** - Focus on specific features
3. **Set breakpoints in VS Code** - Debug specific test failures
4. **Check test comments** - Each test has descriptive comments
5. **Review test file directly** - Tests are well-documented and readable

---

## ✨ Summary

You now have **50 comprehensive tests** that validate:
- ✅ Webview creation and configuration
- ✅ Message protocol and communication
- ✅ UI interactions and navigation
- ✅ Data processing and rendering
- ✅ Settings persistence
- ✅ Security and password enforcement
- ✅ Error handling and edge cases

**Next Step:** Run `npm test` and watch all 50 tests pass! 🎉
