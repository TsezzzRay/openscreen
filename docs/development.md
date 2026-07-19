# OpenScreen Next Development Capabilities

- One active session
- Complete retention of all turns within the session
- User input, window screenshot, and model output in every turn
- Multi-turn text context within the session
- Multi-turn screenshot context within the session
- Dynamic request construction based on the model context budget
- Automatic compaction when text and screenshots exceed the context budget
- Plain-text summary generation from compacted text and screenshots, without screenshot paths, turn IDs, or reference markers
- Local retention of original screenshots independently from turns included in model context or the summary
- Reloading of historical screenshots by turn reference
- Streaming model output
- Request ID correlation across input, output, and streaming events
- Clearing the current conversation context when starting a new session
