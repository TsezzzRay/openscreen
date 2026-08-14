import Foundation
import XCTest
@testable import OpenScreen

final class AgentProtocolTests: XCTestCase {
    private let requestID = "request-1"
    private let sessionID = "session-1"

    func testPromptRequestUsesOnlyTextAndProductImageFields() throws {
        let line = try AgentRequest.prompt(
            requestID: requestID,
            sessionID: sessionID,
            text: "What is on screen?",
            images: [
                ProductImageAttachment(path: "/tmp/one.png", mimeType: .png),
                ProductImageAttachment(path: "/tmp/two.jpg", mimeType: .jpeg),
            ]
        ).encodedLine()
        let object = try jsonObject(line)
        let input = try XCTUnwrap(object["input"] as? [String: Any])
        let images = try XCTUnwrap(input["images"] as? [[String: String]])

        XCTAssertEqual(Set(object.keys), ["requestId", "type", "sessionId", "input"])
        XCTAssertEqual(object["requestId"] as? String, requestID)
        XCTAssertEqual(object["type"] as? String, "prompt")
        XCTAssertEqual(object["sessionId"] as? String, sessionID)
        XCTAssertEqual(input["text"] as? String, "What is on screen?")
        XCTAssertEqual(images, [
            ["path": "/tmp/one.png", "mimeType": "image/png"],
            ["path": "/tmp/two.jpg", "mimeType": "image/jpeg"],
        ])
        XCTAssertNil(images.first?["id"])
        XCTAssertNil(images.first?["source"])
        XCTAssertEqual(line.last, Character("\n").asciiValue)
    }

    func testEveryProductCommandUsesExactShape() throws {
        let cases: [(AgentRequest, String, Set<String>)] = [
            (.listSessions(requestID: requestID), "list_sessions", ["requestId", "type"]),
            (.createSession(requestID: requestID), "create_session", ["requestId", "type"]),
            (.getSession(requestID: requestID, sessionID: sessionID), "get_session", ["requestId", "type", "sessionId"]),
            (.renameSession(requestID: requestID, sessionID: sessionID, name: "Project"), "rename_session", ["requestId", "type", "sessionId", "name"]),
            (.abort(requestID: requestID, sessionID: sessionID, targetRequestID: "prompt-1"), "abort", ["requestId", "type", "sessionId", "targetRequestId"]),
            (.compact(requestID: requestID, sessionID: sessionID, instructions: nil), "compact", ["requestId", "type", "sessionId"]),
            (.compact(requestID: requestID, sessionID: sessionID, instructions: "Preserve decisions"), "compact", ["requestId", "type", "sessionId", "instructions"]),
            (.setThinking(requestID: requestID, sessionID: sessionID, thinking: .high), "set_thinking", ["requestId", "type", "sessionId", "thinking"]),
        ]

        for (request, type, keys) in cases {
            let object = try jsonObject(request.encodedLine())
            XCTAssertEqual(object["type"] as? String, type)
            XCTAssertEqual(Set(object.keys), keys, "Unexpected shape for \(type)")
        }
    }

    func testSessionViewDecodesLinearTranscriptAndState() throws {
        let event = try decodeEvent(#"{"requestId":"request-1","type":"session_view","view":{"session":{"id":"session-1","createdAt":"2026-08-13T00:00:00.000Z","name":"Project"},"messages":[{"id":"m1","role":"user","timestamp":"2026-08-13T00:00:01.000Z","text":"Question","imageCount":2},{"id":"m2","role":"assistant","timestamp":"2026-08-13T00:00:02.000Z","text":"Answer","reasoning":"Checked"},{"id":"m3","role":"tool","timestamp":"2026-08-13T00:00:03.000Z","text":"output","toolName":"read","isError":false}],"state":{"thinking":"high"}}}"#)

        XCTAssertEqual(event.kind, .sessionView)
        let view = try XCTUnwrap(event.view)
        XCTAssertEqual(view.session.id, sessionID)
        XCTAssertEqual(view.session.name, "Project")
        XCTAssertEqual(view.messages.map(\.role), [.user, .assistant, .tool])
        XCTAssertEqual(view.messages.first?.imageCount, 2)
        XCTAssertEqual(view.state.thinking, .high)
    }

    func testToolLifecycleDecode() throws {
        let started = try decodeEvent(#"{"requestId":"r","type":"tool_started","sessionId":"s","callId":"c","name":"read","input":{"path":"README.md","line":1}}"#)
        let updated = try decodeEvent(#"{"requestId":"r","type":"tool_updated","sessionId":"s","callId":"c","name":"read","text":"partial"}"#)
        let finished = try decodeEvent(#"{"requestId":"r","type":"tool_finished","sessionId":"s","callId":"c","name":"read","text":"done","isError":false}"#)

        XCTAssertEqual(started.kind, .toolStarted)
        XCTAssertEqual(started.tool?.input?["path"], .string("README.md"))
        XCTAssertEqual(started.tool?.input?["line"], .number(1))
        XCTAssertEqual(updated.tool?.text, "partial")
        XCTAssertEqual(finished.tool?.isError, false)
    }

    func testStreamingCompletionAndContextUsageDecode() throws {
        let reasoning = try decodeEvent(#"{"requestId":"r","type":"reasoning_delta","sessionId":"s","delta":"Checking"}"#)
        let answer = try decodeEvent(#"{"requestId":"r","type":"answer_delta","sessionId":"s","delta":"Answer"}"#)
        let completed = try decodeEvent(#"{"requestId":"r","type":"answer_completed","sessionId":"s","answer":"Answer","contextUsage":{"contextTokens":123,"contextWindow":1000}}"#)

        XCTAssertEqual(reasoning.delta, "Checking")
        XCTAssertEqual(answer.delta, "Answer")
        XCTAssertEqual(completed.answer, "Answer")
        XCTAssertEqual(completed.contextUsage, .init(contextTokens: 123, contextWindow: 1000))
    }

    func testCompactionStateAbortAndFailureDecode() throws {
        let compaction = try decodeEvent(#"{"requestId":"r","type":"compaction_completed","sessionId":"s","automatic":false,"result":{"summary":"Summary","firstKeptEntryId":"m2","tokensBefore":500}}"#)
        let state = try decodeEvent(#"{"requestId":"r","type":"state_updated","sessionId":"s","state":{"thinking":"medium"}}"#)
        let abort = try decodeEvent(#"{"requestId":"r","type":"abort_completed","targetRequestId":"prompt"}"#)
        let failed = try decodeEvent(#"{"requestId":"r","type":"failed","error":{"code":"provider","message":"secret provider detail"}}"#)

        XCTAssertEqual(compaction.compaction?.summary, "Summary")
        XCTAssertEqual(compaction.automatic, false)
        XCTAssertEqual(state.state?.thinking, .medium)
        XCTAssertEqual(abort.targetRequestId, "prompt")
        XCTAssertEqual(failed.failure, .init(code: .provider, message: "secret provider detail"))
    }

    func testAgentClientEntrypointIsProductMain() {
        XCTAssertEqual(AgentClient.launchArguments, ["node", "agent/dist/main.js"])
    }

    func testProductProtocolAndUIHaveNoModelEnumerationOrSwitching() throws {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let relativePaths = [
            "Sources/OpenScreen/Agent/AgentProtocol.swift",
            "Sources/OpenScreen/Agent/AgentClient.swift",
            "Sources/OpenScreen/Chat/ChatViewModel.swift",
            "Sources/OpenScreen/Chat/ChatView.swift",
        ]
        let forbidden = [
            "ProductModelRef",
            "ProductModelSummary",
            "listModels",
            "setModel",
            "list_models",
            "set_model",
            "loadModels",
            "selectModel",
        ]

        for relativePath in relativePaths {
            let source = try String(
                contentsOf: repositoryRoot.appendingPathComponent(relativePath),
                encoding: .utf8
            )
            for token in forbidden {
                XCTAssertFalse(source.contains(token), "\(relativePath) still contains \(token)")
            }
        }
    }

    func testProductProtocolIsLinearAndHasNoToolSwitching() throws {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let relativePaths = [
            "Sources/OpenScreen/Agent/AgentProtocol.swift",
            "Sources/OpenScreen/Agent/AgentClient.swift",
            "Sources/OpenScreen/Chat/ChatViewModel.swift",
            "Sources/OpenScreen/Chat/ChatView.swift",
        ]
        let forbidden = [
            "ProductTree",
            "ProductNavigation",
            "navigationCompleted",
            "sessionStateUncertain",
            "setActiveTools",
            "set_active_tools",
            "sourceMessageID",
            "sessionTree",
            "activeTools",
            "availableTools",
        ]

        for relativePath in relativePaths {
            let source = try String(
                contentsOf: repositoryRoot.appendingPathComponent(relativePath),
                encoding: .utf8
            )
            for token in forbidden {
                XCTAssertFalse(source.contains(token), "\(relativePath) still contains \(token)")
            }
        }
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: repositoryRoot
                    .appendingPathComponent("Sources/OpenScreen/Chat/SessionTreeView.swift")
                    .path
            )
        )
    }

    func testUnknownFutureEventIdentifiesOnlyItsCorrelatedRequest() throws {
        let unknown = try AgentClient.decodeLine(Data(
            #"{"requestId":"first","type":"future_event","payload":true}"#.utf8
        ))
        let valid = try AgentClient.decodeLine(Data(
            #"{"requestId":"second","type":"completed"}"#.utf8
        ))

        XCTAssertEqual(unknown.requestID, "first")
        XCTAssertNil(unknown.event)
        XCTAssertEqual(valid.requestID, "second")
        XCTAssertEqual(valid.event?.kind, .completed)
    }

    func testErrorsUseStableUserFacingMessages() {
        XCTAssertEqual(
            AgentClientError.requestFailed(.init(code: .provider, message: "provider secret")).errorDescription,
            "Request failed. Please retry."
        )
        XCTAssertEqual(
            AgentClientError.processExited.errorDescription,
            "The agent stopped. Restart OpenScreen and try again."
        )
    }

    func testAgentClientRejectsRequestsBeforeTheProcessStarts() async {
        let client = AgentClient()

        do {
            _ = try await client.listSessions()
            XCTFail("A request sent before start should fail")
        } catch {
            guard case AgentClientError.processExited = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
    }

    func testAgentClientDrainsFinalStdoutBeforeReportingProcessExit() async throws {
        let script = #"""
        const readline = require("node:readline");
        const lines = readline.createInterface({ input: process.stdin });
        lines.once("line", (line) => {
          const { requestId } = JSON.parse(line);
          const output = [
            { requestId, type: "sessions", sessions: [] },
            { requestId, type: "completed" },
          ].map(JSON.stringify).join("\n") + "\n";
          process.stdout.write(output, () => process.exit(0));
        });
        """#
        let client = AgentClient(launchArguments: ["node", "-e", script])
        try await client.start()

        let sessions = try await client.listSessions()

        XCTAssertEqual(sessions, [])
        await client.stop()
    }

    func testAgentClientReadsAJsonlLineLargerThan64KiB() async throws {
        let script = #"""
        const readline = require("node:readline");
        const lines = readline.createInterface({ input: process.stdin });
        lines.once("line", (line) => {
          const { requestId } = JSON.parse(line);
          const sessions = Array.from({ length: 1400 }, (_, index) => ({
            id: `session-${index}`,
            createdAt: "2026-08-13T00:00:00.000Z",
            name: "A session name long enough to exceed the old fixed read size",
          }));
          process.stdout.write(JSON.stringify({ requestId, type: "sessions", sessions }) + "\n", () => {
            process.stdout.write(JSON.stringify({ requestId, type: "completed" }) + "\n");
          });
        });
        """#
        let client = AgentClient(launchArguments: ["node", "-e", script])
        try await client.start()
        let completed = expectation(description: "large JSONL response completed")
        let result = AgentSessionsResultBox()
        Task {
            defer { completed.fulfill() }
            await result.store(try? await client.listSessions())
        }

        await fulfillment(of: [completed], timeout: 2)
        await client.stop()
        let sessions = await result.value()

        XCTAssertEqual(sessions?.count, 1400)
    }

    func testApplicationTerminationWaitsForAgentShutdown() throws {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("Sources/OpenScreen/App/AppDelegate.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(source.contains("func applicationShouldTerminate("))
        XCTAssertTrue(source.contains("return .terminateLater"))
        XCTAssertTrue(source.contains("await agentClient.stop()"))
        XCTAssertTrue(source.contains("reply(toApplicationShouldTerminate: true)"))
        XCTAssertFalse(source.contains("func applicationWillTerminate("))
    }

    func testAgentClientStopWaitsForGracefulProcessExit() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let marker = directory.appendingPathComponent("stopped.txt")
        let script = #"""
        const fs = require("node:fs");
        const marker = process.argv[1];
        process.stdin.resume();
        process.stdin.once("end", () => {
          setTimeout(() => fs.writeFileSync(marker, "stopped"), 50);
        });
        """#
        let client = AgentClient(
            launchArguments: ["node", "-e", script, marker.path]
        )
        try await client.start()

        await client.stop()

        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path))
    }

    func testAgentClientStopIsBoundedWhenTheProcessIgnoresTermination() async throws {
        let script = #"""
        process.on("SIGTERM", () => {
          setTimeout(() => process.exit(0), 2000);
        });
        process.stdin.resume();
        setInterval(() => {}, 1000);
        """#
        let client = AgentClient(launchArguments: ["node", "-e", script])
        try await client.start()
        let clock = ContinuousClock()
        let started = clock.now

        await client.stop()

        XCTAssertLessThan(started.duration(to: clock.now), .seconds(1.5))
    }

    private func decodeEvent(_ json: String) throws -> AgentEvent {
        try JSONDecoder().decode(AgentEvent.self, from: Data(json.utf8))
    }

    private func jsonObject(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

private actor AgentSessionsResultBox {
    private var sessions: [ProductSessionSummary]?

    func store(_ sessions: [ProductSessionSummary]?) {
        self.sessions = sessions
    }

    func value() -> [ProductSessionSummary]? {
        sessions
    }
}
