# Code Coverage Test Suite

## Purpose
This folder contains comprehensive test files designed to achieve 100% code coverage for the TBD Logger extension.

## Test Files

### 1. extension.coverage.test.ts
Tests for the main extension activation and deactivation logic:
- Extension activation flow
- Command registration
- Initial state setup
- Deactivation cleanup
- API exposure for testing

### 2. utils.coverage.test.ts
Tests for utility functions:
- `formatTimestamp()` - timestamp formatting with timezone handling
- `formatDuration()` - duration formatting (HH:MM:SS)
- `isIgnoredPath()` - path filtering logic

### 3. listeners.coverage.test.ts
Tests for all event listeners:
- **editListener**: Text document changes, paste detection, delete detection, AI detection
- **focusListener**: Active editor changes, focus tracking
- **saveListener**: Document save events, metadata tracking
- **windowStateListener**: Window focus changes

### 4. ui-components.coverage.test.ts
Tests for UI components:
- **statusBar**: Status bar creation, icons, tooltips, hidden items
- **uiTimer**: Timer updates, AWAY/REC states, color changes
- **confidenceIndicator**: Confidence scoring, gap detection, pause detection, integrity warnings

### 5. handlers.coverage.test.ts
Tests for focus handlers:
- `handleFocusLost()` - Focus loss detection and UI updates
- `handleFocusRegained()` - Focus regain and event logging
- Focus state transitions

### 6. session-management.coverage.test.ts
Tests for session management:
- **sessionInfo**: User and project detection
- **sessionInterruptions**: Interruption tracking, activity monitoring, clean shutdown detection

### 7. teacher-dashboard.coverage.test.ts
Tests for teacher dashboard components:
- Dashboard app initialization
- Service functions (analyze logs, generate profile, generate timeline)
- File operations (open, export, deletions, notes)
- HTML generation
- Message handling

### 8. types-and-state.coverage.test.ts
Tests for types and state management:
- `StandardEvent` interface validation
- State object properties
- CONSTANTS validation
- StorageManager interface

## Running the Tests

### Compile tests:
```powershell
npm run compile-tests
```

### Run all tests:
```powershell
npm test
```

### Run only code coverage tests:
```powershell
npm test -- --grep "Code Coverage"
```

### Run tests with coverage reporting:
You may need to add a coverage tool like `c8` or `nyc`:
```powershell
npm install --save-dev c8
npx c8 npm test
```

## Coverage Goals

These tests aim to cover:
- ✅ All exported functions
- ✅ All conditional branches
- ✅ All event handlers
- ✅ Error handling paths
- ✅ Edge cases and boundary conditions
- ✅ Integration between modules

## Test Structure

Each test suite follows this pattern:
1. **Setup**: Initialize mocks and reset state
2. **Test**: Execute the code under test
3. **Assert**: Verify expected behavior
4. **Teardown**: Clean up resources

## Mocking Strategy

Tests use VS Code's testing utilities and create minimal mocks for:
- `vscode.ExtensionContext`
- `vscode.StatusBarItem`
- `vscode.WebviewPanel`
- Document and editor instances

## Notes

- Tests are designed to run in isolation
- State is reset between tests to prevent interference
- Timers and async operations use appropriate timeouts
- Tests avoid actual file system operations when possible
- Password-protected operations are tested with mock passwords

## Maintenance

When adding new features to the extension:
1. Add corresponding tests to the appropriate coverage file
2. Ensure new code paths are exercised
3. Update this README if adding new test files
4. Run tests to verify no regressions

## Continuous Integration

These tests should be run:
- Before each commit
- In CI/CD pipelines
- Before creating releases
- After dependency updates
