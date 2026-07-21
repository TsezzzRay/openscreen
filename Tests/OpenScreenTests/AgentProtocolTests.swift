import XCTest
@testable import OpenScreen

@MainActor
final class AgentProtocolTests: XCTestCase {
    func testAgentRequestEncoding() throws {
        let requestID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let sessionID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        let images = [
            ChatImageAttachment(
                id: "system",
                source: .systemCapture,
                path: "/tmp/window.png"
            ),
            ChatImageAttachment(
                id: "upload-1",
                source: .userUpload,
                path: "/tmp/one.png"
            ),
            ChatImageAttachment(
                id: "upload-2",
                source: .userUpload,
                path: "/tmp/two.png"
            ),
        ]
        let data = try AgentRequest.chat(
            requestID: requestID,
            sessionID: sessionID,
            text: "What is on screen?",
            images: images
        ).encodedLine()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let input = try XCTUnwrap(object["input"] as? [String: Any])
        let encodedImages = try XCTUnwrap(input["images"] as? [[String: String]])

        XCTAssertEqual(object["requestId"] as? String, requestID.uuidString)
        XCTAssertEqual(object["type"] as? String, "chat")
        XCTAssertEqual(object["sessionId"] as? String, sessionID.uuidString)
        XCTAssertEqual(input["text"] as? String, "What is on screen?")
        XCTAssertEqual(encodedImages, [
            ["id": "system", "source": "system_capture", "path": "/tmp/window.png"],
            ["id": "upload-1", "source": "user_upload", "path": "/tmp/one.png"],
            ["id": "upload-2", "source": "user_upload", "path": "/tmp/two.png"],
        ])
        XCTAssertEqual(data.last, Character("\n").asciiValue)
    }

    func testRenameSessionRequestEncoding() throws {
        let requestID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let sessionID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        let data = try AgentRequest.renameSession(
            requestID: requestID,
            sessionID: sessionID,
            title: "Project notes"
        ).encodedLine()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        XCTAssertEqual(object["type"] as? String, "rename_session")
        XCTAssertEqual(object["sessionId"] as? String, sessionID.uuidString)
        XCTAssertEqual(object["title"] as? String, "Project notes")
    }

    func testCancelRequestEncoding() throws {
        let requestID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let sessionID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        let targetID = UUID(uuidString: "00000000-0000-0000-0000-000000000003")!
        let data = try AgentRequest.cancel(
            requestID: requestID,
            sessionID: sessionID,
            targetRequestID: targetID
        ).encodedLine()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        XCTAssertEqual(object["type"] as? String, "cancel")
        XCTAssertEqual(object["sessionId"] as? String, sessionID.uuidString)
        XCTAssertEqual(object["targetRequestId"] as? String, targetID.uuidString)
    }

    func testRecordCancelledAttemptEncoding() throws {
        let sessionID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        let data = try AgentRequest.recordAttempt(
            requestID: UUID(),
            sessionID: sessionID,
            text: "Stop before capture",
            images: [ChatImageAttachment(
                id: "upload-1",
                source: .userUpload,
                path: "/tmp/one.png"
            )],
            status: .cancelled
        ).encodedLine()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let input = try XCTUnwrap(object["input"] as? [String: Any])

        XCTAssertEqual(object["type"] as? String, "record_attempt")
        XCTAssertEqual(object["status"] as? String, "cancelled")
        XCTAssertEqual(input["text"] as? String, "Stop before capture")
        XCTAssertEqual((input["images"] as? [[String: String]])?.first?["source"], "user_upload")
    }

    func testAgentEventDecoding() throws {
        let data = Data(
            #"{"requestId":"00000000-0000-0000-0000-000000000001","sessionId":"00000000-0000-0000-0000-000000000002","type":"answer_delta","delta":"Hello"}"#.utf8
        )

        let event = try JSONDecoder().decode(AgentEvent.self, from: data)

        XCTAssertEqual(event.type, .answerDelta)
        XCTAssertEqual(event.delta, "Hello")
        XCTAssertEqual(
            event.sessionId,
            UUID(uuidString: "00000000-0000-0000-0000-000000000002")
        )
    }

    func testAgentErrorsUseStableUserMessages() {
        XCTAssertEqual(
            AgentClientError.requestFailed("provider secret").errorDescription,
            "Request failed. Please retry."
        )
        XCTAssertEqual(
            AgentClientError.processExited.errorDescription,
            "The agent stopped. Restart OpenScreen and try again."
        )
        XCTAssertEqual(
            AgentClientError.invalidResponse.errorDescription,
            "Request failed. Please retry."
        )
    }

    func testSessionSnapshotEventDecoding() throws {
        let data = Data(
            #"{"requestId":"00000000-0000-0000-0000-000000000001","type":"session","session":{"id":"00000000-0000-0000-0000-000000000002","title":"Project notes","createdAt":"2026-07-19T00:00:00.000Z","updatedAt":"2026-07-19T01:00:00.000Z","turns":[{"id":"00000000-0000-0000-0000-000000000003","user":"Question","assistant":"Partial answer","reasoning":"Checked screen","status":"interrupted","images":[{"id":"upload-1","source":"user_upload","path":"/tmp/one.png"},{"id":"upload-2","source":"user_upload","path":"/tmp/two.png"}]}]}}"#.utf8
        )

        let event = try JSONDecoder().decode(AgentEvent.self, from: data)

        XCTAssertEqual(event.type, .session)
        XCTAssertEqual(event.session?.title, "Project notes")
        XCTAssertEqual(event.session?.turns.first?.assistant, "Partial answer")
        XCTAssertEqual(event.session?.turns.first?.status, .interrupted)
        XCTAssertEqual(event.session?.turns.first?.images?.map(\.path), ["/tmp/one.png", "/tmp/two.png"])
    }
}
