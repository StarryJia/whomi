import React from 'react'

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
}

class MessageErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div role="alert" className="conversation-error rounded-md border px-3 py-2 text-sm">
          无法显示此消息，请重新打开对话。
        </div>
      )
    }
    return this.props.children
  }
}

export default MessageErrorBoundary
